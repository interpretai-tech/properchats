import { expect, test } from "@playwright/test";
import {
  isToolConfigured,
  manifestToToolDefs,
  runToolDef,
} from "../src/lib/tools/defs";
import { UI_PAYLOAD_KEY } from "../src/lib/tools/manifest";
import {
  ALLOWED_MODELS,
  BAD_MODEL_COPY,
  DEFAULT_MODEL,
  isAllowedResultUrl,
  MAX_IMAGE_DATAURL_CHARS,
  MAX_PROMPT_CHARS,
  OVERSIZE_PROMPT_COPY,
} from "../src/lib/tools/bindings/fal";
import { TOOL_UI_MAX_DATAURL_CHARS } from "../src/lib/server/providers";
import {
  byokToolHourlyLimit,
  getToolCallCounts,
  getToolManifest,
  invokeTool,
} from "../src/lib/tools/registry";

/**
 * fal.ai text-to-image binding — shape tests against *recorded* vendor
 * responses (CONTRIBUTING_TOOLS.md §3; no live calls, no real keys), plus
 * bridge discovery/refusal specs.
 *
 * Fixture provenance: response shapes are DERIVED FROM fal's public docs
 * (fal.ai/docs/model-apis/quickstart, …/inference/synchronous + queue, and
 * the fal-ai/flux/schnell model schema page), fetched 2026-06 — not from a
 * recorded live call. Verifying against a live FAL_KEY is a deploy-time
 * TODO (the live bridge test below runs skip-unless-configured).
 *
 * Protocol pins (a dead key must never mask drift):
 *   POST https://fal.run/{model_id}    Authorization: Key $FAL_KEY
 *   result: { images: [{url, width, height, content_type}], seed, … }
 *   hosted result files live on https://fal.media/…
 *
 * Security pins:
 *   - model ALLOWLIST: free-form model ids are refused before any fetch
 *     (an open model arg = open proxy to arbitrary-priced models);
 *   - result-host pin: a hosted image URL is fetched ONLY from fal.media
 *     (or a subdomain); any other host → refusal with ZERO further fetches;
 *   - SVG/gif/html can never reach the dataUrl (bitmap whitelist only).
 */

// ── Recorded fal response shapes (docs-derived; see provenance note) ───────

/** Tiny stand-in png body (8-byte PNG signature + padding). */
const RECORDED_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk start
]);
const PNG_B64 = Buffer.from(RECORDED_PNG).toString("base64");
const PNG_DATAURL = `data:image/png;base64,${PNG_B64}`;

/** sync_mode response: the image arrives as a data URI, no second fetch. */
const RECORDED_SYNC_RESULT = {
  images: [{ url: PNG_DATAURL, width: 1024, height: 768, content_type: "image/png" }],
  timings: { inference: 0.42 },
  seed: 1234567890,
  has_nsfw_concepts: [false],
  prompt: "a futuristic cityscape at sunset",
};

/** Hosted-URL response: the docs' example output host (fal.media). */
const HOSTED_URL = "https://fal.media/files/tiger/m0K3P3JUR_Brcf7mxk3tl.png";
const RECORDED_HOSTED_RESULT = {
  images: [{ url: HOSTED_URL, width: 1024, height: 768, content_type: "image/png" }],
  timings: { inference: 0.42 },
  seed: 42,
  has_nsfw_concepts: [false],
  prompt: "a tiger",
};

const FAKE_KEY = "fal-test-not-a-real-key";

const realFetch = globalThis.fetch;
const realKey = process.env.FAL_KEY;

test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.FAL_KEY;
  else process.env.FAL_KEY = realKey;
});

interface SeenRequest {
  url: string;
  method?: string;
  authorization?: string;
  payload?: Record<string, unknown>;
}

/**
 * Stub fetch: the first matching response per URL prefix. `submit` answers
 * POST fal.run/…; `file` (optional) answers the hosted-file GET. Everything
 * is recorded in `seen` so host-pinning tests can assert ZERO extra fetches.
 */
function stubFetch(
  submit: { body: BodyInit; status?: number; contentType?: string },
  file?: { body: BodyInit; status?: number; contentType?: string },
): SeenRequest[] {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url: u,
      method: init?.method ?? "GET",
      authorization: headers.Authorization,
      payload: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    const r = u.startsWith("https://fal.run/") || !file ? submit : file;
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: { "content-type": r.contentType ?? "application/json" },
    });
  }) as typeof fetch;
  return seen;
}

// ── Union degradation: no key ⇒ strip, never error ──────────────────────────

test("image_gen without FAL_KEY is STRIPPED from the defs, not errored", () => {
  delete process.env.FAL_KEY;
  expect(isToolConfigured(getToolManifest("image_gen")!)).toBe(false);
  const names = manifestToToolDefs().map((d) => d.name);
  expect(names).not.toContain("image_gen__generate_image");
  // The rest of the union keeps working.
  expect(names).toContain("weather__get_weather");
});

test("no-key forced dispatch returns normalized error data, never throws", async () => {
  delete process.env.FAL_KEY;
  const result = (await runToolDef("image_gen__generate_image", { prompt: "a cat" })) as {
    error?: string;
  };
  expect(result.error).toContain("not configured");
  expect(result.error).toContain("FAL_KEY");
});

// ── Shape: full model-tool path against recorded vendor responses ───────────

test("generate_image shape (sync_mode data URI): pinned endpoint/header, metadata result, NO base64 in the model loop, ONE fetch", async () => {
  process.env.FAL_KEY = FAKE_KEY;
  expect(manifestToToolDefs().map((d) => d.name)).toContain("image_gen__generate_image");

  const seen = stubFetch({ body: JSON.stringify(RECORDED_SYNC_RESULT) });
  const before = getToolCallCounts().image_gen ?? 0;
  const result = (await runToolDef("image_gen__generate_image", {
    prompt: "a futuristic cityscape at sunset",
  })) as Record<string, unknown>;

  // Protocol pins: fal's synchronous host, default model in the path,
  // documented auth header form `Authorization: Key $FAL_KEY`.
  expect(seen).toHaveLength(1); // data URI result ⇒ no second fetch
  expect(seen[0].url).toBe(`https://fal.run/${DEFAULT_MODEL}`);
  expect(seen[0].method).toBe("POST");
  expect(seen[0].authorization).toBe(`Key ${FAKE_KEY}`);
  expect(seen[0].payload?.prompt).toBe("a futuristic cityscape at sunset");
  expect(seen[0].payload?.sync_mode).toBe(true);
  expect(seen[0].payload?.num_images).toBe(1);

  // Model-visible result: compact metadata plus an explicit placeholder.
  expect(result.model).toBe(DEFAULT_MODEL);
  expect(result.width).toBe(1024);
  expect(result.height).toBe(768);
  expect(result.seed).toBe(1234567890);
  expect(result.contentType).toBe("image/png");
  expect(result.image).toBe(`<omitted: ${RECORDED_PNG.byteLength} bytes image/png>`);

  // The binary-output rule: NO image payload in the model loop. The UI-only
  // key is stripped, and the serialized result (exactly what providers.ts
  // feeds back as tool_result) carries zero base64 and stays compact.
  expect(result[UI_PAYLOAD_KEY]).toBeUndefined();
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("base64");
  expect(serialized).not.toContain(PNG_B64);
  expect(serialized.length).toBeLessThan(500);

  // One-seam metering: the dispatch incremented the per-tool counter.
  expect(getToolCallCounts().image_gen).toBe(before + 1);
});

test("bridge-seam dispatch (invokeTool) DOES carry the UI image payload, kind:'image'", async () => {
  process.env.FAL_KEY = FAKE_KEY;
  stubFetch({ body: JSON.stringify(RECORDED_SYNC_RESULT) });
  const result = (await invokeTool("image_gen", "generate_image", { prompt: "a cat" })) as Record<
    string,
    { kind: string; dataUrl: string; contentType: string; bytes: number }
  >;
  const ui = result[UI_PAYLOAD_KEY];
  expect(ui.kind).toBe("image");
  expect(ui.contentType).toBe("image/png");
  expect(ui.dataUrl).toBe(PNG_DATAURL);
});

test("hosted-URL result: bytes fetched from fal.media WITHOUT the API key, converted to a data URL", async () => {
  process.env.FAL_KEY = FAKE_KEY;
  const seen = stubFetch(
    { body: JSON.stringify(RECORDED_HOSTED_RESULT) },
    { body: RECORDED_PNG, contentType: "image/png" },
  );
  const result = (await invokeTool("image_gen", "generate_image", { prompt: "a tiger" })) as Record<
    string,
    unknown
  >;

  expect(seen).toHaveLength(2);
  expect(seen[1].url).toBe(HOSTED_URL);
  // The API key must never be replayed to the CDN host the vendor response chose.
  expect(seen[1].authorization).toBeUndefined();

  expect(result.bytes).toBe(RECORDED_PNG.byteLength);
  const ui = result[UI_PAYLOAD_KEY] as { kind: string; dataUrl: string };
  expect(ui.kind).toBe("image");
  expect(ui.dataUrl).toBe(PNG_DATAURL);
});

// ── SSRF stance: result-host pinning ────────────────────────────────────────

for (const evil of [
  "https://evil.example/steal.png",
  "https://fal.media.evil.com/steal.png", // suffix spoof: not *.fal.media
  "http://fal.media/files/x.png", // right host, wrong scheme
  "ftp://fal.media/files/x.png",
]) {
  test(`hosted URL on a non-fal host is refused with ZERO further fetches: ${evil}`, async () => {
    process.env.FAL_KEY = FAKE_KEY;
    const hostile = {
      ...RECORDED_HOSTED_RESULT,
      images: [{ url: evil, width: 1024, height: 768, content_type: "image/png" }],
    };
    const seen = stubFetch(
      { body: JSON.stringify(hostile) },
      { body: RECORDED_PNG, contentType: "image/png" },
    );
    const result = (await runToolDef("image_gen__generate_image", { prompt: "x" })) as {
      error?: string;
    };
    expect(result.error).toContain("refusing");
    expect(seen).toHaveLength(1); // only the submit; the hostile URL was never fetched
  });
}

test("isAllowedResultUrl: exact pins", () => {
  expect(isAllowedResultUrl("https://fal.media/files/a/b.png")).toBe(true);
  expect(isAllowedResultUrl("https://v3.fal.media/files/a/b.png")).toBe(true);
  expect(isAllowedResultUrl("https://fal.media.evil.com/x.png")).toBe(false);
  expect(isAllowedResultUrl("https://notfal.media/x.png")).toBe(false);
  expect(isAllowedResultUrl("http://fal.media/x.png")).toBe(false);
  expect(isAllowedResultUrl("not a url")).toBe(false);
});

// ── Bitmap whitelist: SVG and friends can never reach the dataUrl ──────────

test("sync_mode data URI in a non-bitmap format (svg+xml) is refused", async () => {
  process.env.FAL_KEY = FAKE_KEY;
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const body = {
    ...RECORDED_SYNC_RESULT,
    images: [{ url: `data:image/svg+xml;base64,${svg.toString("base64")}` }],
  };
  stubFetch({ body: JSON.stringify(body) });
  const result = (await runToolDef("image_gen__generate_image", { prompt: "x" })) as {
    error?: string;
  };
  expect(result.error).toContain("unsupported image format");
});

test("hosted bytes with an SVG content-type are pinned to image/png, never embedded as svg", async () => {
  process.env.FAL_KEY = FAKE_KEY;
  // A hostile/odd CDN response must never choose the dataUrl mime: outside
  // image/(png|jpeg|webp) the binding hard-pins image/png — the format it
  // requested via output_format. SVG is the XSS-relevant case (scriptable).
  stubFetch(
    { body: JSON.stringify(RECORDED_HOSTED_RESULT) },
    { body: RECORDED_PNG, contentType: "image/svg+xml" },
  );
  const result = (await invokeTool("image_gen", "generate_image", { prompt: "x" })) as Record<
    string,
    unknown
  >;
  expect(result.contentType).toBe("image/png");
  const ui = result[UI_PAYLOAD_KEY] as { dataUrl: string };
  expect(ui.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  expect(ui.dataUrl).not.toContain("svg");
});

// ── Model allowlist: free-form model args are refused, no fetch ─────────────

test("a free-form model id is refused before any fetch; allowlisted ids land in the URL path", async () => {
  process.env.FAL_KEY = FAKE_KEY;
  const seen = stubFetch({ body: JSON.stringify(RECORDED_SYNC_RESULT) });

  for (const model of [
    "fal-ai/veo3", // plausible but unlisted (video — per-second billing)
    "fal-ai/flux/schnell/../../evil",
    "https://evil.example/run",
    "",
  ]) {
    const bad = (await runToolDef("image_gen__generate_image", { prompt: "x", model })) as {
      error?: string;
    };
    expect(bad.error).toBe(BAD_MODEL_COPY);
  }
  expect(seen).toHaveLength(0); // refusals never reached the vendor

  await runToolDef("image_gen__generate_image", { prompt: "x", model: "fal-ai/flux/dev" });
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe("https://fal.run/fal-ai/flux/dev");
});

test("the manifest's model enum matches the binding allowlist exactly", () => {
  const manifest = getToolManifest("image_gen")!;
  if (manifest.binding.kind !== "webhook") throw new Error("expected webhook binding");
  const fn = manifest.binding.functions.find((f) => f.name === "generate_image")!;
  const props = fn.parameters.properties as Record<string, { enum?: string[] }>;
  expect(props.model.enum).toEqual([...ALLOWED_MODELS]);
});

// ── Caps: prompt input, image output ────────────────────────────────────────

test("prompt over the size cap is refused with instructive copy, no upstream call", async () => {
  process.env.FAL_KEY = FAKE_KEY;
  const seen = stubFetch({ body: JSON.stringify(RECORDED_SYNC_RESULT) });
  const result = (await runToolDef("image_gen__generate_image", {
    prompt: "a".repeat(MAX_PROMPT_CHARS + 1),
  })) as { error?: string };
  expect(result.error).toBe(OVERSIZE_PROMPT_COPY);
  expect(result.error).toContain("Shorten");
  expect(seen).toHaveLength(0);
});

test("an oversize image is refused with instructive copy; the cap equals the server _ui cap", async () => {
  // The binding-side cap MUST track the providers.ts whitelist cap — a
  // binding-side pass the server then drops would silently lose the image.
  expect(MAX_IMAGE_DATAURL_CHARS).toBe(TOOL_UI_MAX_DATAURL_CHARS);

  process.env.FAL_KEY = FAKE_KEY;
  const huge = Buffer.alloc(Math.ceil((MAX_IMAGE_DATAURL_CHARS / 4) * 3) + 1024);
  const body = {
    ...RECORDED_SYNC_RESULT,
    images: [{ url: `data:image/png;base64,${huge.toString("base64")}`, width: 4096, height: 4096 }],
  };
  stubFetch({ body: JSON.stringify(body) });
  const result = (await runToolDef("image_gen__generate_image", { prompt: "x" })) as {
    error?: string;
  };
  expect(result.error).toContain("too large");
  expect(result.error).toContain("smaller image");
});

// ── Normalizer owns the copy ────────────────────────────────────────────────

for (const status of [401, 422, 500]) {
  test(`vendor ${status} comes back as OUR copy, never vendor prose`, async () => {
    process.env.FAL_KEY = FAKE_KEY;
    stubFetch({
      body: JSON.stringify({ detail: "InternalRunnerTrace at line 42", error_type: "panic" }),
      status,
    });
    const result = (await runToolDef("image_gen__generate_image", { prompt: "x" })) as {
      error?: string;
    };
    expect(result.error).toBe(`fal.ai responded ${status}`);
    expect(JSON.stringify(result)).not.toContain("InternalRunnerTrace");
  });
}

// ── Budget seam: media draws the generic BYOK hourly budget ────────────────

test("image_gen draws the generic 60/h BYOK budget (media, not social)", () => {
  // Documented choice: image generation is read-only spend on the deployer's
  // key (cents per image; ~$1.50/h worst case at 60×flux/dev) with no shared
  // external authority — the tighter 15/h social budget is reserved for
  // tools that act on real accounts.
  const manifest = getToolManifest("image_gen")!;
  expect(manifest.category).toBe("media");
  const limitEnv = process.env.TOOLS_BYOK_TOOL_LIMIT;
  delete process.env.TOOLS_BYOK_TOOL_LIMIT;
  try {
    expect(byokToolHourlyLimit(manifest)).toBe(60);
  } finally {
    if (limitEnv !== undefined) process.env.TOOLS_BYOK_TOOL_LIMIT = limitEnv;
  }
});

// ── Bridge route: discovery + unconfigured refusal (live server) ────────────

test("image_gen discovery: GET /api/tools/image_gen returns the manifest, BYOK, secret-free", async ({
  request,
}) => {
  const res = await request.get("/api/tools/image_gen");
  expect(res.ok()).toBeTruthy();
  const manifest = await res.json();
  expect(manifest.id).toBe("image_gen");
  expect(manifest.pricing).toBe("byok");
  expect(manifest.category).toBe("media");
  expect(manifest.maintainer).toBeTruthy();
  expect(manifest.auth.secrets).toEqual(["FAL_KEY"]);
  expect(manifest.binding.functions.map((f: { name: string }) => f.name)).toEqual([
    "generate_image",
  ]);
  // The discovery payload must never leak the key's value.
  expect(JSON.stringify(manifest)).not.toContain(process.env.FAL_KEY ?? " no-key-on-this-host ");
});

test("image_gen bridge: unconfigured server refuses with 503", async ({ request }) => {
  test.skip(!!process.env.FAL_KEY, "server has a key; live dispatch covered below");
  const res = await request.post("/api/tools/image_gen", {
    data: { function: "generate_image", args: { prompt: "a small red cube" } },
  });
  expect(res.status()).toBe(503);
  const body = await res.json();
  expect(body.error).toContain("not configured");
});

test("image_gen bridge: live generation (BYOK) returns metadata + UI dataUrl", async ({
  request,
}) => {
  test.skip(!process.env.FAL_KEY, "FAL_KEY not configured (live verification = deploy-time TODO)");
  const res = await request.post("/api/tools/image_gen", {
    data: { function: "generate_image", args: { prompt: "a small red cube on a white table" } },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.result.contentType).toMatch(/^image\//);
  expect(body.result.bytes).toBeGreaterThan(0);
  expect(body.result[UI_PAYLOAD_KEY].kind).toBe("image");
  expect(body.result[UI_PAYLOAD_KEY].dataUrl).toMatch(/^data:image\//);
});
