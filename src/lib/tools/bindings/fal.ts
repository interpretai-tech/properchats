/**
 * Text-to-image binding — proxies fal.ai (https://fal.ai), the hosted
 * model-inference API. BYOK: the server needs FAL_KEY (fal's documented env
 * var name — keys come from the fal dashboard; usage-billed, no free tier:
 * FLUX schnell ≈ $0.003/megapixel, FLUX dev $0.025/image — see fal.ai/pricing).
 *
 * Protocol (verified against fal.ai/docs 2026-06: model-apis/quickstart,
 * model-apis/inference/synchronous + queue, models/fal-ai/flux/schnell/api):
 *
 *   POST https://fal.run/{model_id}            Authorization: Key $FAL_KEY
 *
 * `fal.run` is fal's synchronous host ("no queue and no status polling" —
 * the result returns on the same connection), the simplest REST path for a
 * fast model like FLUX schnell (~1-2s). The queue host (queue.fal.run) and
 * its submit/poll protocol exist for long jobs; deliberately not used here.
 *
 * Output handling — bytes vs URL. We send `sync_mode: true` (documented on
 * the flux schnell schema: "media returns as a data URI and isn't stored in
 * request history"), so the happy path needs NO second fetch. Defense in
 * depth: if the vendor returns a hosted URL anyway, we fetch the bytes
 * server-side ONLY from fal's own result host (`fal.media`, e.g.
 * https://fal.media/files/tiger/….png per their docs) — any other host is
 * refused outright. That host pin is the SSRF stance: a vendor response is
 * attacker-influencable input, and this binding must never become a proxy
 * that fetches arbitrary URLs with server egress.
 *
 * Model ids are an ALLOWLIST, never a free-form string: fal serves hundreds
 * of models at wildly different prices (video models bill per second), so a
 * free-form `model` arg would be an open proxy to arbitrary spend on the
 * deployer's key.
 *
 * Binary output follows the elevenlabs.ts precedent exactly: the
 * model-visible result is compact metadata ({model, width, height, seed,
 * bytes, image: "<omitted: …>"}); the actual image rides under the reserved
 * UI_PAYLOAD_KEY ("_ui") as a base64 data: URL, stripped by runToolDef
 * before the model loop, passed through by the bridge route.
 */
import { ToolError, UI_PAYLOAD_KEY } from "../manifest";

const FAL_BASE = process.env.FAL_BASE_URL || "https://fal.run";

/** Image generation is slower than a text API round-trip; ~30s covers
 *  schnell/dev cold starts while still bounding a wedged request. */
const FETCH_TIMEOUT_MS = 30_000;

/** Agent-sized input cap; also bounds one call's token-shaped spend. */
export const MAX_PROMPT_CHARS = 2_000;

/**
 * The model allowlist. NEVER accept a free-form model id — fal routes by
 * model id in the URL path and bills per model, so an open string arg is an
 * open proxy to arbitrary-priced models (video models bill per second of
 * output) on the deployer's key. Grow this list deliberately, with pricing
 * reviewed per addition.
 */
export const ALLOWED_MODELS = [
  "fal-ai/flux/schnell", // default: fastest + cheapest (~$0.003/megapixel)
  "fal-ai/flux/dev", // higher quality, $0.025/image
] as const;
export const DEFAULT_MODEL: (typeof ALLOWED_MODELS)[number] = "fal-ai/flux/schnell";

/**
 * Max chars of the produced base64 data: URL. MUST stay equal to
 * TOOL_UI_MAX_DATAURL_CHARS in src/lib/server/providers.ts (the `_ui`
 * whitelist cap) — a binding-side pass that the server whitelist then drops
 * would silently lose the image. Kept as a local constant because importing
 * server/providers from a binding would be a layering cycle; equality is
 * pinned by tests/fal-image.spec.ts.
 */
export const MAX_IMAGE_DATAURL_CHARS = 4_200_000;

/**
 * Image mimes allowed into the `_ui` dataUrl (mirrors the server whitelist in
 * providers.ts). SVG is DELIBERATELY excluded everywhere in this pipeline:
 * SVG is a scriptable document format (`<script>`, event handlers, foreign
 * objects), not a bitmap — rendering vendor-supplied SVG in the chat DOM
 * would be an XSS hole. Anything outside this set is pinned to image/png
 * (the format this binding requests via output_format).
 */
const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Strict bitmap-image data URI form (same anchors as the server whitelist:
 *  `$` matches end-of-input only, so an embedded newline can't smuggle a
 *  suffix; `=` padding only at the very end). */
const IMAGE_DATAURL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/;

/** Result-host pin for the bytes fetch when fal returns a hosted URL instead
 *  of a data URI: fal's file CDN is fal.media (their docs' example output is
 *  https://fal.media/files/…); subdomains like v3.fal.media stay theirs.
 *  Suffix-anchored on a leading dot, so `fal.media.evil.com` never passes. */
const RESULT_HOST = "fal.media";

export const OVERSIZE_PROMPT_COPY =
  `\`prompt\` is too long for one generate_image call (max ${MAX_PROMPT_CHARS} characters). ` +
  "Shorten the prompt — image models use the first sentences most; trailing detail is largely ignored anyway.";

export const OVERSIZE_IMAGE_COPY =
  "fal.ai returned an image too large to deliver in chat. " +
  "Ask for a smaller image (e.g. a square or landscape_4_3 size) and try again.";

export const BAD_MODEL_COPY =
  `\`model\` must be one of: ${ALLOWED_MODELS.join(", ")} (default ${DEFAULT_MODEL}). ` +
  "Other fal.ai models are not enabled on this server.";

function apiKey(): string {
  const key = process.env.FAL_KEY;
  if (!key) {
    throw new ToolError(
      "Image generation is not configured on this server (FAL_KEY is unset)",
      503,
    );
  }
  return key;
}

/** True for an https URL on fal's result CDN (fal.media or a subdomain). */
export function isAllowedResultUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    (url.hostname === RESULT_HOST || url.hostname.endsWith(`.${RESULT_HOST}`))
  );
}

/** The slice of fal's image-model output this binding consumes. */
interface FalImage {
  url?: unknown;
  width?: unknown;
  height?: unknown;
  content_type?: unknown;
}

export interface GenerateImageResult {
  model: string;
  width?: number;
  height?: number;
  seed?: number;
  contentType: string;
  /** Size of the generated image in bytes. */
  bytes: number;
  /** Model-facing placeholder — the image itself never enters the loop. */
  image: string;
  /** UI-only payload; stripped from the model-visible result by runToolDef. */
  [UI_PAYLOAD_KEY]: { kind: "image"; dataUrl: string; contentType: string; bytes: number };
}

export async function generateImage(
  args: Record<string, unknown>,
): Promise<GenerateImageResult> {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new ToolError("`prompt` is required", 400);
  if (prompt.length > MAX_PROMPT_CHARS) throw new ToolError(OVERSIZE_PROMPT_COPY, 400);

  // Allowlist, not validation: anything outside the pinned set — including a
  // syntactically plausible fal model id — is refused before any fetch.
  let model: string = DEFAULT_MODEL;
  if (args.model !== undefined) {
    const requested = typeof args.model === "string" ? args.model.trim() : "";
    if (!(ALLOWED_MODELS as readonly string[]).includes(requested)) {
      throw new ToolError(BAD_MODEL_COPY, 400);
    }
    model = requested;
  }

  const key = apiKey(); // resolve before the try: its 503 must not become a 502
  let res: Response;
  try {
    // fal's synchronous host: result returns on the same connection.
    // sync_mode asks for the image as a data URI (no second fetch needed);
    // output_format pins png so the produced mime is deterministic.
    res = await fetch(`${FAL_BASE}/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, num_images: 1, sync_mode: true, output_format: "png" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ToolError("fal.ai request failed or timed out", 502);
  }
  if (!res.ok) {
    // Normalizer owns the copy: fal error bodies ({detail, error_type})
    // carry vendor prose and internals — they never leave this function.
    throw new ToolError(`fal.ai responded ${res.status}`, 502);
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new ToolError("fal.ai returned an unreadable result", 502);
  }
  const images = Array.isArray(body.images) ? (body.images as FalImage[]) : [];
  const first = images[0];
  const rawUrl = first && typeof first.url === "string" ? first.url : "";
  if (!rawUrl) {
    throw new ToolError("fal.ai returned no image for this prompt", 502);
  }

  let dataUrl: string;
  let contentType: string;
  let bytes: number;
  if (rawUrl.startsWith("data:")) {
    // sync_mode happy path: the image is already a data URI. Accept only the
    // strict bitmap form (png/jpeg/webp, pure base64) — anything else (SVG,
    // gif, junk) is refused, never forwarded.
    if (!IMAGE_DATAURL_RE.test(rawUrl)) {
      throw new ToolError("fal.ai returned an unsupported image format", 502);
    }
    dataUrl = rawUrl;
    contentType = rawUrl.slice("data:".length, rawUrl.indexOf(";"));
    const b64 = rawUrl.slice(rawUrl.indexOf(",") + 1);
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    bytes = (b64.length / 4) * 3 - padding;
  } else {
    // Hosted-URL path: fetch the bytes ONLY from fal's own result CDN. Any
    // other host in the vendor response is refused with zero further
    // fetches — this binding must never proxy arbitrary URLs.
    if (!isAllowedResultUrl(rawUrl)) {
      throw new ToolError("fal.ai returned an image URL outside its own CDN — refusing to fetch it", 502);
    }
    let fileRes: Response;
    try {
      // No Authorization header: fal.media is a public CDN, and the API key
      // must not be replayed to a host the vendor response chose.
      fileRes = await fetch(rawUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      throw new ToolError("fal.ai request failed or timed out", 502);
    }
    if (!fileRes.ok) {
      throw new ToolError(`fal.ai responded ${fileRes.status}`, 502);
    }
    // Never trust the CDN's Content-Type into the dataUrl: outside the bitmap
    // allowlist (notably image/svg+xml — scriptable, XSS) it is pinned to
    // image/png, the format this binding requested via output_format.
    const vendorType =
      fileRes.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "image/png";
    contentType = vendorType;
    if (!IMAGE_CONTENT_TYPES.has(vendorType)) {
      console.warn(
        `[image_gen] fal.ai returned unexpected content-type "${vendorType}" — pinning image/png`,
      );
      contentType = "image/png";
    }
    const buf = Buffer.from(await fileRes.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new ToolError("fal.ai returned no image for this prompt", 502);
    }
    bytes = buf.byteLength;
    dataUrl = `data:${contentType};base64,${buf.toString("base64")}`;
  }

  if (dataUrl.length > MAX_IMAGE_DATAURL_CHARS) {
    throw new ToolError(OVERSIZE_IMAGE_COPY, 502);
  }

  const width = first && typeof first.width === "number" ? first.width : undefined;
  const height = first && typeof first.height === "number" ? first.height : undefined;
  const seed = typeof body.seed === "number" ? body.seed : undefined;

  return {
    model,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(seed !== undefined ? { seed } : {}),
    contentType,
    bytes,
    image: `<omitted: ${bytes} bytes ${contentType}>`,
    [UI_PAYLOAD_KEY]: { kind: "image", dataUrl, contentType, bytes },
  };
}
