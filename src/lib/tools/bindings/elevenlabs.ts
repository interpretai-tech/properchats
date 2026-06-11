/**
 * Text-to-speech binding — proxies ElevenLabs (https://elevenlabs.io), the
 * hosted TTS API. BYOK: the server needs ELEVENLABS_API_KEY (free tier covers
 * 10,000 characters/month; paid tiers bill per character — see
 * elevenlabs.io/pricing). Point ELEVENLABS_BASE_URL at a proxy if needed; the
 * binding never fetches user-supplied URLs (fixed-base pattern, SSRF n/a).
 *
 * This is the catalog's first NON-TEXT tool: the vendor returns AUDIO BYTES
 * (audio/mpeg), and a tool result must never inline megabytes of base64 into
 * the model loop (providers.ts JSON.stringifies the whole result into the
 * tool_result block). Two defenses, both deliberate precedent for future
 * audio/image/file tools:
 *
 * 1. **Size cap** — text over MAX_TTS_CHARS is refused up front with
 *    instructive copy (also keeps one call inside the vendor free tier's
 *    practical budget).
 * 2. **Split-channel result** — the model-visible result is metadata only
 *    ({ voiceId, characters, contentType, bytes, audio: "<omitted: …>" }).
 *    The actual audio rides in the reserved UI_PAYLOAD_KEY ("_ui") field as a
 *    data: URL: `runToolDef` strips that key before the result reaches the
 *    model, while the `/api/tools/tts` bridge route returns it intact for UI
 *    callers. See UI_PAYLOAD_KEY in ../manifest.
 */
import { ToolError, UI_PAYLOAD_KEY } from "../manifest";

const ELEVENLABS_BASE =
  process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io";
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Agent-sized input cap. ~2,500 chars is roughly 2½ minutes of speech
 * (~2–3 MB of mp3) — the most one bridge response should carry, and a quarter
 * of the vendor's 10k-chars/month free tier.
 */
export const MAX_TTS_CHARS = 2_500;

/** Default voice: "Rachel" (21m00Tcm4TlvDq8ikWAM), an ElevenLabs premade
 *  voice available to every account — documented in the function schema. */
export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/** Multilingual default model; callers don't choose models in v1. */
const MODEL_ID = "eleven_multilingual_v2";

/** list_voices is compact and capped: id + name + labels only. */
const MAX_VOICES = 25;

/** Audio mimes allowed into the `_ui` dataUrl (mirrors the server whitelist
 *  in providers.ts); any other vendor Content-Type is pinned to audio/mpeg. */
const AUDIO_CONTENT_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/ogg"]);

export const OVERSIZE_TTS_COPY =
  `\`text\` is too long for one text_to_speech call (max ${MAX_TTS_CHARS} characters). ` +
  "Shorten the text or split it into multiple calls and tell the user each clip is generated separately.";

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new ToolError(
      "Text to speech is not configured on this server (ELEVENLABS_API_KEY is unset)",
      503,
    );
  }
  return key;
}

/** Fetch one ElevenLabs v1 endpoint. Normalizer owns all copy: vendor error
 *  bodies (which include prose and internals) never leave this function. */
async function elevenlabs(path: string, init: RequestInit): Promise<Response> {
  const key = apiKey(); // resolve before the try: its 503 must not become a 502
  let res: Response;
  try {
    res = await fetch(`${ELEVENLABS_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), "xi-api-key": key },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ToolError("ElevenLabs request failed or timed out", 502);
  }
  if (!res.ok) {
    throw new ToolError(`ElevenLabs responded ${res.status}`, 502);
  }
  return res;
}

export interface TextToSpeechResult {
  voiceId: string;
  /** Characters synthesized (what the vendor bills per). */
  characters: number;
  contentType: string;
  /** Size of the generated clip in bytes. */
  bytes: number;
  /** Model-facing placeholder — the audio itself never enters the loop. */
  audio: string;
  /** UI-only payload; stripped from the model-visible result by runToolDef. */
  [UI_PAYLOAD_KEY]: { dataUrl: string; contentType: string; bytes: number };
}

export async function textToSpeech(
  args: Record<string, unknown>,
): Promise<TextToSpeechResult> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) throw new ToolError("`text` is required", 400);
  if (text.length > MAX_TTS_CHARS) throw new ToolError(OVERSIZE_TTS_COPY, 400);
  const voiceId =
    typeof args.voiceId === "string" && args.voiceId.trim()
      ? args.voiceId.trim()
      : DEFAULT_VOICE_ID;
  // Voice ids are vendor tokens, not URLs — but they land in the request
  // path, so refuse anything that isn't a plain token.
  if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId)) {
    throw new ToolError("`voiceId` must be an ElevenLabs voice id (use list_voices)", 400);
  }

  const res = await elevenlabs(
    `/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: MODEL_ID }),
    },
  );
  // Never trust the vendor's Content-Type into the dataUrl: anything outside
  // the audio allowlist (the three mimes the _ui whitelist renders) is pinned
  // to audio/mpeg — the format this binding requested via Accept. Defense in
  // depth regardless of which seam consumes the payload.
  const vendorType =
    res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "audio/mpeg";
  let contentType = vendorType;
  if (!AUDIO_CONTENT_TYPES.has(vendorType)) {
    console.warn(
      `[tts] ElevenLabs returned unexpected content-type "${vendorType}" — pinning audio/mpeg`,
    );
    contentType = "audio/mpeg";
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new ToolError("ElevenLabs returned no audio for this request", 502);
  }
  return {
    voiceId,
    characters: text.length,
    contentType,
    bytes: buf.byteLength,
    audio: `<omitted: ${buf.byteLength} bytes ${contentType}>`,
    [UI_PAYLOAD_KEY]: {
      dataUrl: `data:${contentType};base64,${buf.toString("base64")}`,
      contentType,
      bytes: buf.byteLength,
    },
  };
}

export interface VoiceSummary {
  id: string;
  name: string;
  /** Vendor labels, e.g. { accent, gender, age, use_case } — short strings. */
  labels: Record<string, string>;
}

export async function listVoices(): Promise<{
  voices: VoiceSummary[];
  truncated: boolean;
  defaultVoiceId: string;
}> {
  const res = await elevenlabs("/v1/voices", { method: "GET" });
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new ToolError("ElevenLabs returned an unreadable voice list", 502);
  }
  const rows = Array.isArray(body.voices) ? body.voices : [];
  const voices: VoiceSummary[] = rows.slice(0, MAX_VOICES).map((r) => {
    const row = r as Record<string, unknown>;
    const rawLabels = (row.labels ?? {}) as Record<string, unknown>;
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawLabels)) {
      if (typeof v === "string" && v) labels[k] = v.slice(0, 60);
    }
    return {
      id: typeof row.voice_id === "string" ? row.voice_id : "",
      name: typeof row.name === "string" ? row.name : "",
      labels,
    };
  });
  return { voices, truncated: rows.length > MAX_VOICES, defaultVoiceId: DEFAULT_VOICE_ID };
}
