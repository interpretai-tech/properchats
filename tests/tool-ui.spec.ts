import { expect, type Page, test } from "@playwright/test";
import {
  dispatch,
  sanitizeToolUiPayload,
  TOOL_UI_MAX_DATAURL_CHARS,
  type DispatchInput,
} from "../src/lib/server/providers";
import type { StreamEvent } from "../src/lib/types";

/**
 * The `_ui` last-mile: a chat-loop tool result that carries the reserved
 * UI-only payload (UI_PAYLOAD_KEY, e.g. ElevenLabs TTS audio) is delivered to
 * the chat client as ONE `tool_ui` SSE event, while the model-visible
 * tool_result stays metadata-only. Per-tool-spec conventions: recorded vendor
 * shapes, stubbed provider streams, no live calls, no real keys.
 *
 * Pinned behaviors:
 * - a whitelisted `_ui` audio payload → one `tool_ui` event {tool, fn, payload}
 *   with registry-resolved names, alongside the existing status/trace events;
 * - the tool_result fed back to the model contains NO dataUrl / base64 audio;
 * - whitelist: ONLY {kind:"audio", dataUrl: data:audio/(mpeg|wav|ogg);base64,…}
 *   of bounded size; anything else (wrong mime/kind, junk chars, oversize) is
 *   DROPPED silently — no tool_ui event, no error event, stream completes;
 * - UI: the audio chip renders a native <audio controls> with the dataUrl and
 *   a "{tool} audio" label; no autoplay (mocked /api/chat, fully offline).
 */

const realFetch = globalThis.fetch;
const realKey = process.env.ELEVENLABS_API_KEY;
test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = realKey;
});

// ── Recorded shapes ─────────────────────────────────────────────────────────

/** Tiny stand-in mp3 body (real responses are audio/mpeg byte streams). */
const RECORDED_AUDIO = new Uint8Array([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // "ID3" header
  0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // mp3 frame sync
]);
const AUDIO_B64 = Buffer.from(RECORDED_AUDIO).toString("base64");
const AUDIO_DATAURL = `data:audio/mpeg;base64,${AUDIO_B64}`;

function sseResponse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface SeenRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Stub fetch for BOTH seams of a TTS tool turn: ElevenLabs requests get the
 * recorded vendor body; everything else is the stubbed provider stream (the
 * last round repeats). Only provider requests are recorded in `seen`.
 */
function stubLoopAndVendor(
  rounds: unknown[][],
  vendor: { body: BodyInit; contentType: string },
): SeenRequest[] {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.elevenlabs.io")) {
      return new Response(vendor.body, {
        status: 200,
        headers: { "content-type": vendor.contentType },
      });
    }
    seen.push({ url: u, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const events = rounds[Math.min(seen.length - 1, rounds.length - 1)];
    return sseResponse(events);
  }) as typeof fetch;
  return seen;
}

async function collect(input: DispatchInput): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of dispatch(input)) events.push(ev);
  return events;
}

function makeInput(): DispatchInput {
  return {
    route: "direct",
    provider: "openai",
    model: "test-model",
    system: "",
    messages: [{ role: "user", content: "say hi out loud" }],
    maxTokens: 256,
    keys: { openai: "k-o" },
  };
}

const TTS_CALL = { name: "tts__text_to_speech", args: { text: "hi" } };

function openaiToolRound(calls: { id: string; name: string; args: string }[]) {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: calls.map((c, i) => ({
              index: i,
              id: c.id,
              function: { name: c.name, arguments: c.args },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function openaiTextRound(text: string) {
  return [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
}

// ── Loop: _ui audio → one tool_ui event; model sees metadata only ──────────

test("a tool result carrying _ui audio emits ONE tool_ui event; the model-visible tool_result has no dataUrl", async () => {
  process.env.ELEVENLABS_API_KEY = "el-test-not-a-real-key";
  const seen = stubLoopAndVendor(
    [
      openaiToolRound([{ id: "c1", name: TTS_CALL.name, args: JSON.stringify(TTS_CALL.args) }]),
      openaiTextRound("Played."),
    ],
    { body: RECORDED_AUDIO, contentType: "audio/mpeg" },
  );
  const events = await collect(makeInput());

  // One tool_ui event, registry-resolved names, whitelisted payload.
  const uiEvents = events.filter((e) => e.type === "tool_ui");
  expect(uiEvents).toHaveLength(1);
  const ui = uiEvents[0] as Extract<StreamEvent, { type: "tool_ui" }>;
  expect(ui.tool).toBe("tts");
  expect(ui.fn).toBe("text_to_speech");
  expect(ui.payload).toEqual({ kind: "audio", dataUrl: AUDIO_DATAURL });

  // Existing status/trace events still flow around it.
  expect(events.some((e) => e.type === "status" && e.text.includes("Text to speech"))).toBe(true);
  expect(events.some((e) => e.type === "trace" && e.text.includes("Text to speech"))).toBe(true);

  // The tool_result fed back to the model: metadata only, zero audio bytes.
  expect(seen).toHaveLength(2);
  const toolMsg = (seen[1].body.messages as { role: string; content?: string }[]).find(
    (m) => m.role === "tool",
  );
  expect(toolMsg?.content).toContain("audio/mpeg"); // metadata survives
  expect(toolMsg?.content).not.toContain("dataUrl");
  expect(toolMsg?.content).not.toContain(AUDIO_B64);

  expect(events.some((e) => e.type === "delta" && e.text === "Played.")).toBe(true);
  expect(events.some((e) => e.type === "done")).toBe(true);
});

test("a non-audio _ui payload (wrong mime) is dropped: no tool_ui, no error, stream completes", async () => {
  process.env.ELEVENLABS_API_KEY = "el-test-not-a-real-key";
  // Vendor replies video/mp4 → the binding's dataUrl is data:video/mp4;… →
  // fails the v1 whitelist → dropped with a console.warn, never an event.
  stubLoopAndVendor(
    [
      openaiToolRound([{ id: "c1", name: TTS_CALL.name, args: JSON.stringify(TTS_CALL.args) }]),
      openaiTextRound("ok"),
    ],
    { body: RECORDED_AUDIO, contentType: "video/mp4" },
  );
  const events = await collect(makeInput());

  expect(events.some((e) => e.type === "tool_ui")).toBe(false);
  expect(events.some((e) => e.type === "error")).toBe(false);
  expect(events.some((e) => e.type === "trace")).toBe(true); // the call still ran
  expect(events.some((e) => e.type === "done")).toBe(true);
});

// ── Whitelist unit pins (the exact v1 rules) ────────────────────────────────

test("sanitizeToolUiPayload: v1 accepts only bounded base64 audio data URLs", () => {
  // The raw elevenlabs `_ui` shape (no explicit kind) normalizes to audio.
  expect(sanitizeToolUiPayload({ dataUrl: AUDIO_DATAURL, contentType: "audio/mpeg", bytes: 20 }))
    .toEqual({ kind: "audio", dataUrl: AUDIO_DATAURL });
  // Explicit audio kind passes; wav/ogg mimes pass.
  expect(sanitizeToolUiPayload({ kind: "audio", dataUrl: AUDIO_DATAURL })).not.toBeNull();
  expect(sanitizeToolUiPayload({ dataUrl: `data:audio/wav;base64,${AUDIO_B64}` })).not.toBeNull();
  expect(sanitizeToolUiPayload({ dataUrl: `data:audio/ogg;base64,${AUDIO_B64}` })).not.toBeNull();

  // Dropped: unknown kind, non-audio mime, non-base64 data URL, junk chars,
  // non-object payloads, missing dataUrl.
  expect(sanitizeToolUiPayload({ kind: "image", dataUrl: AUDIO_DATAURL })).toBeNull();
  expect(sanitizeToolUiPayload({ dataUrl: `data:video/mp4;base64,${AUDIO_B64}` })).toBeNull();
  expect(sanitizeToolUiPayload({ dataUrl: `data:text/html;base64,${AUDIO_B64}` })).toBeNull();
  expect(sanitizeToolUiPayload({ dataUrl: "data:audio/mpeg,not-base64" })).toBeNull();
  expect(sanitizeToolUiPayload({ dataUrl: 'data:audio/mpeg;base64,abc"<script>' })).toBeNull();
  expect(sanitizeToolUiPayload({ dataUrl: "https://example.com/a.mp3" })).toBeNull();
  expect(sanitizeToolUiPayload(AUDIO_DATAURL)).toBeNull();
  expect(sanitizeToolUiPayload(null)).toBeNull();
  expect(sanitizeToolUiPayload({ kind: "audio" })).toBeNull();

  // Oversize: one char past the cap is dropped; at the cap passes.
  const prefix = "data:audio/mpeg;base64,";
  const atCap = prefix + "A".repeat(TOOL_UI_MAX_DATAURL_CHARS - prefix.length);
  expect(sanitizeToolUiPayload({ dataUrl: atCap })).not.toBeNull();
  expect(sanitizeToolUiPayload({ dataUrl: atCap + "A" })).toBeNull();
});

// ── UI: the audio chip renders from a mocked stream ─────────────────────────

const composer = (page: Page) => page.getByTestId("composer-main");

test("tool_ui audio renders an <audio controls> chip with the dataUrl, no autoplay", async ({
  page,
}) => {
  const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/config", (r) =>
    r.fulfill({ json: { interpret: true, anthropic: true, openai: true, gemini: true } }),
  );
  await page.route("**/api/model-window", (r) => r.fulfill({ json: { window: 1_000_000 } }));
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
      body: sse([
        { type: "start", provider: "openai", route: "direct", model: "test-model" },
        { type: "status", text: "Running Text to speech (text_to_speech)…" },
        { type: "tool_ui", tool: "tts", fn: "text_to_speech", payload: { kind: "audio", dataUrl: AUDIO_DATAURL } },
        { type: "trace", text: "Used Text to speech (text_to_speech)" },
        { type: "delta", text: "Here you go — press play." },
        { type: "done", usage: { input: 10, output: 5 }, stopReason: "stop" },
      ]),
    }),
  );
  await page.goto("/");
  await expect(composer(page)).toBeVisible({ timeout: 45_000 });

  await composer(page).getByTestId("composer-input").fill("Say hi out loud.");
  await composer(page).getByTestId("send-button").click();

  const chip = page.getByTestId("tool-audio");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("tts audio");
  const audio = chip.locator("audio");
  await expect(audio).toHaveAttribute("src", AUDIO_DATAURL);
  await expect(audio).toHaveAttribute("controls", "");
  await expect(audio).not.toHaveAttribute("autoplay", /.*/);
  // The clip is attached to the message, not floating UI: the reply text rendered too.
  await expect(page.getByTestId("chat-pane")).toContainText("press play");
});
