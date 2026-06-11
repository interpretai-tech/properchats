import { expect, test } from "@playwright/test";
import {
  isToolConfigured,
  manifestToToolDefs,
  runToolDef,
} from "../src/lib/tools/defs";
import { UI_PAYLOAD_KEY } from "../src/lib/tools/manifest";
import {
  DEFAULT_VOICE_ID,
  MAX_TTS_CHARS,
  OVERSIZE_TTS_COPY,
} from "../src/lib/tools/bindings/elevenlabs";
import {
  getToolCallCounts,
  getToolManifest,
  invokeTool,
} from "../src/lib/tools/registry";

/**
 * ElevenLabs TTS binding — shape tests against *recorded* vendor responses
 * (CONTRIBUTING_TOOLS.md §3; no live calls, no real keys), plus the bridge
 * discovery/refusal specs. This is the catalog's first NON-TEXT tool, so the
 * specs here also pin the binary-output precedent: the model-visible result
 * carries metadata only — the audio rides in the reserved UI_PAYLOAD_KEY
 * field, stripped by runToolDef, passed through by the bridge route.
 *
 * Protocol pins (a dead key must never mask drift):
 *   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}  xi-api-key
 *   GET  https://api.elevenlabs.io/v1/voices                      xi-api-key
 */

// ── Recorded ElevenLabs v1 response shapes ──────────────────────────────────

/** A tiny stand-in mp3 body (real responses are audio/mpeg byte streams). */
const RECORDED_AUDIO = new Uint8Array([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // "ID3" header
  0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // mp3 frame sync
]);

/** Recorded GET /v1/voices shape (trimmed to the fields that exist live). */
const RECORDED_VOICES = {
  voices: [
    {
      voice_id: "21m00Tcm4TlvDq8ikWAM",
      name: "Rachel",
      category: "premade",
      labels: { accent: "american", description: "calm", gender: "female", use_case: "narration" },
      preview_url: "https://storage.googleapis.com/eleven-public-prod/premade/voices/rachel.mp3",
      settings: null,
    },
    {
      voice_id: "AZnzlk1XvdvUeBnXmlld",
      name: "Domi",
      category: "premade",
      labels: { accent: "american", gender: "female", use_case: "narration" },
      preview_url: "https://storage.googleapis.com/eleven-public-prod/premade/voices/domi.mp3",
      settings: null,
    },
  ],
};

const FAKE_KEY = "el-test-not-a-real-key";

const realFetch = globalThis.fetch;
const realKey = process.env.ELEVENLABS_API_KEY;

test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = realKey;
});

/** Install a fetch stub that records the request and replies with `body`. */
function stubFetch(body: BodyInit, status = 200, contentType = "application/json") {
  const seen: {
    url: string;
    method?: string;
    xiKey?: string;
    payload?: Record<string, unknown>;
  }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url: String(url),
      method: init?.method,
      xiKey: headers["xi-api-key"],
      payload: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return new Response(body, { status, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return seen;
}

// ── Union degradation: no key ⇒ strip, never error ──────────────────────────

test("tts without ELEVENLABS_API_KEY is STRIPPED from the defs, not errored", () => {
  delete process.env.ELEVENLABS_API_KEY;
  expect(isToolConfigured(getToolManifest("tts")!)).toBe(false);
  const names = manifestToToolDefs().map((d) => d.name);
  expect(names).not.toContain("tts__text_to_speech");
  expect(names).not.toContain("tts__list_voices");
  // The rest of the union keeps working.
  expect(names).toContain("weather__get_weather");
});

test("no-key forced dispatch returns normalized error data, never throws", async () => {
  delete process.env.ELEVENLABS_API_KEY;
  const result = (await runToolDef("tts__text_to_speech", { text: "hi" })) as {
    error?: string;
  };
  expect(result.error).toContain("not configured");
});

// ── Shape: full model-tool path against recorded vendor responses ───────────

test("text_to_speech shape: pinned endpoint/header, metadata result, NO base64 in the model loop", async () => {
  process.env.ELEVENLABS_API_KEY = FAKE_KEY;
  expect(manifestToToolDefs().map((d) => d.name)).toContain("tts__text_to_speech");

  const seen = stubFetch(RECORDED_AUDIO, 200, "audio/mpeg");
  const before = getToolCallCounts().tts ?? 0;
  const result = (await runToolDef("tts__text_to_speech", {
    text: "Hello from ProperChats.",
  })) as Record<string, unknown>;

  // Protocol shape: exact v1 endpoint with the default voice id + xi-api-key.
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_VOICE_ID}`);
  expect(seen[0].method).toBe("POST");
  expect(seen[0].xiKey).toBe(FAKE_KEY);
  expect(seen[0].payload?.text).toBe("Hello from ProperChats.");
  expect(typeof seen[0].payload?.model_id).toBe("string");

  // Model-visible result: compact metadata plus an explicit placeholder.
  expect(result.voiceId).toBe(DEFAULT_VOICE_ID);
  expect(result.characters).toBe("Hello from ProperChats.".length);
  expect(result.contentType).toBe("audio/mpeg");
  expect(result.bytes).toBe(RECORDED_AUDIO.byteLength);
  expect(result.audio).toBe(`<omitted: ${RECORDED_AUDIO.byteLength} bytes audio/mpeg>`);

  // The binary-output precedent: NO audio payload in the model loop. The
  // UI-only key is stripped, and the serialized result (exactly what
  // providers.ts feeds back as tool_result) contains no base64 audio.
  expect(result[UI_PAYLOAD_KEY]).toBeUndefined();
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("base64");
  expect(serialized).not.toContain(Buffer.from(RECORDED_AUDIO).toString("base64"));
  expect(serialized.length).toBeLessThan(500);

  // One-seam metering: the dispatch incremented the per-tool counter.
  expect(getToolCallCounts().tts).toBe(before + 1);
});

test("bridge-seam dispatch (invokeTool) DOES carry the UI audio payload", async () => {
  process.env.ELEVENLABS_API_KEY = FAKE_KEY;
  stubFetch(RECORDED_AUDIO, 200, "audio/mpeg");
  const result = (await invokeTool("tts", "text_to_speech", { text: "hi" })) as Record<
    string,
    { dataUrl: string; contentType: string; bytes: number }
  >;
  const ui = result[UI_PAYLOAD_KEY];
  expect(ui.contentType).toBe("audio/mpeg");
  expect(ui.bytes).toBe(RECORDED_AUDIO.byteLength);
  expect(ui.dataUrl).toBe(
    `data:audio/mpeg;base64,${Buffer.from(RECORDED_AUDIO).toString("base64")}`,
  );
});

test("explicit voiceId lands in the request path; junk voice ids are refused", async () => {
  process.env.ELEVENLABS_API_KEY = FAKE_KEY;
  const seen = stubFetch(RECORDED_AUDIO, 200, "audio/mpeg");
  await runToolDef("tts__text_to_speech", { text: "hi", voiceId: "AZnzlk1XvdvUeBnXmlld" });
  expect(seen[0].url).toBe("https://api.elevenlabs.io/v1/text-to-speech/AZnzlk1XvdvUeBnXmlld");

  const bad = (await runToolDef("tts__text_to_speech", {
    text: "hi",
    voiceId: "../v1/user",
  })) as { error?: string };
  expect(bad.error).toContain("voice id");
  expect(seen).toHaveLength(1); // refusal happened before any fetch
});

test("list_voices shape: pinned GET endpoint, compact capped rows (id+name+labels only)", async () => {
  process.env.ELEVENLABS_API_KEY = FAKE_KEY;
  const seen = stubFetch(JSON.stringify(RECORDED_VOICES));
  const result = (await runToolDef("tts__list_voices", {})) as {
    voices: { id: string; name: string; labels: Record<string, string> }[];
    truncated: boolean;
    defaultVoiceId: string;
  };

  expect(seen[0].url).toBe("https://api.elevenlabs.io/v1/voices");
  expect(seen[0].method).toBe("GET");
  expect(seen[0].xiKey).toBe(FAKE_KEY);

  expect(result.defaultVoiceId).toBe(DEFAULT_VOICE_ID);
  expect(result.truncated).toBe(false);
  expect(result.voices).toEqual([
    {
      id: "21m00Tcm4TlvDq8ikWAM",
      name: "Rachel",
      labels: { accent: "american", description: "calm", gender: "female", use_case: "narration" },
    },
    {
      id: "AZnzlk1XvdvUeBnXmlld",
      name: "Domi",
      labels: { accent: "american", gender: "female", use_case: "narration" },
    },
  ]);
  // Compact means compact: vendor extras (preview_url, settings) are dropped.
  expect(JSON.stringify(result)).not.toContain("preview_url");
});

// ── Oversize input refusal ──────────────────────────────────────────────────

test("text over the size cap is refused with instructive copy, no upstream call", async () => {
  process.env.ELEVENLABS_API_KEY = FAKE_KEY;
  const seen = stubFetch(RECORDED_AUDIO, 200, "audio/mpeg");
  const result = (await runToolDef("tts__text_to_speech", {
    text: "a".repeat(MAX_TTS_CHARS + 1),
  })) as { error?: string };
  expect(result.error).toBe(OVERSIZE_TTS_COPY);
  expect(result.error).toContain("split it");
  expect(seen).toHaveLength(0);
});

// ── Normalizer owns the copy ────────────────────────────────────────────────

for (const status of [401, 500]) {
  test(`vendor ${status} comes back as OUR copy, never vendor prose`, async () => {
    process.env.ELEVENLABS_API_KEY = FAKE_KEY;
    stubFetch(
      JSON.stringify({
        detail: { status: "vendor_panic", message: "InternalVoiceServerTrace at line 42" },
      }),
      status,
    );
    const result = (await runToolDef("tts__text_to_speech", { text: "hi" })) as {
      error?: string;
    };
    expect(result.error).toBe(`ElevenLabs responded ${status}`);
    expect(JSON.stringify(result)).not.toContain("InternalVoiceServerTrace");
  });
}

// ── Bridge route: discovery + unconfigured refusal (live server) ────────────

test("tts discovery: GET /api/tools/tts returns the manifest, BYOK, secret-free", async ({
  request,
}) => {
  const res = await request.get("/api/tools/tts");
  expect(res.ok()).toBeTruthy();
  const manifest = await res.json();
  expect(manifest.id).toBe("tts");
  expect(manifest.pricing).toBe("byok");
  expect(manifest.category).toBe("media");
  expect(manifest.maintainer).toBeTruthy();
  expect(manifest.auth.secrets).toEqual(["ELEVENLABS_API_KEY"]);
  expect(manifest.binding.functions.map((f: { name: string }) => f.name)).toEqual([
    "text_to_speech",
    "list_voices",
  ]);
  // The discovery payload must never leak the key's value.
  expect(JSON.stringify(manifest)).not.toContain(
    process.env.ELEVENLABS_API_KEY ?? " no-key-on-this-host ",
  );
});

test("tts bridge: unconfigured server refuses with 503", async ({ request }) => {
  test.skip(!!process.env.ELEVENLABS_API_KEY, "server has a key; live dispatch covered below");
  const res = await request.post("/api/tools/tts", {
    data: { function: "text_to_speech", args: { text: "hello" } },
  });
  expect(res.status()).toBe(503);
  const body = await res.json();
  expect(body.error).toContain("not configured");
});

test("tts bridge: live synthesis (BYOK) returns metadata + UI dataUrl", async ({ request }) => {
  test.skip(!process.env.ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY not configured");
  const res = await request.post("/api/tools/tts", {
    data: { function: "text_to_speech", args: { text: "Hello from ProperChats." } },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.result.contentType).toContain("audio/");
  expect(body.result.bytes).toBeGreaterThan(0);
  expect(body.result[UI_PAYLOAD_KEY].dataUrl).toMatch(/^data:audio\//);
});
