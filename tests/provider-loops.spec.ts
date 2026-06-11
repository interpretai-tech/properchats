import { expect, test } from "@playwright/test";
import {
  dispatch,
  MAX_PARALLEL_TOOL_CALLS,
  MAX_TOOL_CALLS_PER_TURN,
  TOOL_BAD_ARGS_ERROR,
  TOOL_BUDGET_EXHAUSTED_ERROR,
  TOOL_PARALLEL_CAP_ERROR,
  type DispatchInput,
} from "../src/lib/server/providers";
import type { StreamEvent } from "../src/lib/types";

/**
 * F13: coverage for the three adapter agentic loops (Anthropic / OpenAI /
 * Gemini) against *stubbed* provider streams — recorded SSE shapes, no live
 * vendor calls, no real keys. Tool calls target the keyless calculator
 * binding (mathjs, fully local), so the only fetches are the stubbed
 * provider requests themselves.
 *
 * Pinned behaviors:
 * - bounded rounds: ≤6 tool rounds + 1 tool-less synthesis round (F3 — the
 *   final request carries no community tools, so a call there can't exist);
 * - per-turn budget (F12): 12 dispatches per turn, 4 per round; beyond that
 *   the model gets a structured { error }, the stream is never killed;
 * - malformed JSON args → structured { error }, never a throw;
 * - { error } results feed back and the loop continues;
 * - per-provider termination predicates (stop_reason / finish_reason /
 *   absence of functionCall parts);
 * - F5: loop-fetch rejection → normalized "Provider: …" error event;
 * - F11: status lines show registry-resolved names, never model prose.
 */

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── SSE stub plumbing ───────────────────────────────────────────────────────

function sseResponse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

interface SeenRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Stub fetch with a queue of SSE event-lists; the last entry repeats if the
 * adapter asks for more rounds than scripted. Records every request body.
 */
function stubProvider(rounds: unknown[][]): SeenRequest[] {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
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

function makeInput(provider: "anthropic" | "openai" | "gemini"): DispatchInput {
  return {
    route: "direct",
    provider,
    model: "test-model",
    system: "",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 256,
    keys: { anthropic: "k-a", openai: "k-o", gemini: "k-g" },
  };
}

const CALC = { name: "calculator__calculate", args: { expression: "1+2" } };

// ── Recorded stream shapes per provider ─────────────────────────────────────

function anthropicToolRound(calls: { id: string; name: string; json: string }[]) {
  return [
    { type: "message_start", message: { usage: { input_tokens: 7 } } },
    ...calls.flatMap((c, i) => [
      { type: "content_block_start", index: i, content_block: { type: "tool_use", id: c.id, name: c.name } },
      { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: c.json } },
      { type: "content_block_stop", index: i },
    ]),
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
  ];
}

function anthropicTextRound(text: string) {
  return [
    { type: "message_start", message: { usage: { input_tokens: 9 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
  ];
}

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
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ];
}

function openaiTextRound(text: string) {
  return [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ];
}

function geminiToolRound(calls: { name: string; args: Record<string, unknown> }[]) {
  return [
    {
      candidates: [
        {
          content: { parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) },
          finishReason: "STOP",
        },
      ],
    },
  ];
}

function geminiTextRound(text: string) {
  return [
    {
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
    },
  ];
}

// ── Termination predicates (one per provider — they all differ) ─────────────

test("anthropic: tool round dispatches, result feeds back, end_turn terminates", async () => {
  const seen = stubProvider([
    anthropicToolRound([{ id: "tu_1", name: CALC.name, json: JSON.stringify(CALC.args) }]),
    anthropicTextRound("Three."),
  ]);
  const events = await collect(makeInput("anthropic"));

  expect(seen).toHaveLength(2);
  // Round 2 replays the tool_use and carries our tool_result with the real answer.
  const msgs = seen[1].body.messages as { role: string; content: unknown }[];
  const resultMsg = msgs[msgs.length - 1];
  expect(resultMsg.role).toBe("user");
  const block = (resultMsg.content as { type: string; content: string }[])[0];
  expect(block.type).toBe("tool_result");
  expect(block.content).toContain("3"); // mathjs really ran
  // Registry-resolved status line (F11), then completion.
  expect(events.some((e) => e.type === "status" && e.text === "Running Calculator (calculate)…")).toBe(true);
  expect(events.some((e) => e.type === "delta" && e.text === "Three.")).toBe(true);
  const done = events.find((e) => e.type === "done");
  expect(done && "stopReason" in done && done.stopReason).toBe("end_turn");
});

test("openai: finish_reason stop terminates after a tool round", async () => {
  const seen = stubProvider([
    openaiToolRound([{ id: "call_1", name: CALC.name, args: JSON.stringify(CALC.args) }]),
    openaiTextRound("Three."),
  ]);
  const events = await collect(makeInput("openai"));

  expect(seen).toHaveLength(2);
  const msgs = seen[1].body.messages as { role: string; tool_call_id?: string; content?: string }[];
  const toolMsg = msgs.find((m) => m.role === "tool");
  expect(toolMsg?.tool_call_id).toBe("call_1");
  expect(toolMsg?.content).toContain("3");
  const done = events.find((e) => e.type === "done");
  expect(done && "stopReason" in done && done.stopReason).toBe("stop");
});

test("gemini: a round without functionCall parts terminates the loop", async () => {
  const seen = stubProvider([geminiToolRound([CALC]), geminiTextRound("Three.")]);
  const events = await collect(makeInput("gemini"));

  expect(seen).toHaveLength(2);
  const contents = seen[1].body.contents as { role: string; parts: Record<string, unknown>[] }[];
  const last = contents[contents.length - 1];
  expect(last.role).toBe("user");
  const fr = last.parts[0].function_response as { name: string; response: Record<string, unknown> };
  expect(fr.name).toBe(CALC.name);
  expect(JSON.stringify(fr.response)).toContain("3");
  expect(events.some((e) => e.type === "delta" && e.text === "Three.")).toBe(true);
  expect(events.some((e) => e.type === "done")).toBe(true);
});

// ── Round bound + F3 (no tools on the synthesis round) ──────────────────────

test("openai: at most 6 tool rounds, and the final request carries no tools (F3)", async () => {
  // The stub ALWAYS wants another tool call; the loop must still terminate.
  const seen = stubProvider([
    openaiToolRound([{ id: "c", name: CALC.name, args: JSON.stringify(CALC.args) }]),
  ]);
  const events = await collect(makeInput("openai"));

  expect(seen).toHaveLength(7); // 6 tool rounds + 1 tool-less synthesis round
  for (let i = 0; i < 6; i++) expect(seen[i].body.tools).toBeDefined();
  expect(seen[6].body.tools).toBeUndefined(); // F3: a call here could never dispatch
  expect(events.filter((e) => e.type === "trace").length).toBe(6); // 6 dispatches
  expect(events.some((e) => e.type === "done")).toBe(true); // stream completed cleanly
});

test("anthropic/gemini: final round omits community tools (F3)", async () => {
  const seenA = stubProvider([
    anthropicToolRound([{ id: "t", name: CALC.name, json: JSON.stringify(CALC.args) }]),
  ]);
  await collect(makeInput("anthropic"));
  expect(seenA).toHaveLength(7);
  expect(seenA[5].body.tools).toBeDefined();
  expect(seenA[6].body.tools).toBeUndefined();

  const seenG = stubProvider([geminiToolRound([CALC])]);
  await collect(makeInput("gemini"));
  expect(seenG).toHaveLength(7);
  expect(seenG[5].body.tools).toBeDefined();
  expect(seenG[6].body.tools).toBeUndefined();
});

// ── F12: per-turn budget + per-round parallel cap ───────────────────────────

test("openai: parallel calls all account against the turn budget; overflow gets a structured error", async () => {
  // Every round asks for 4 parallel calls → 12 dispatched after 3 rounds; the
  // 4th round's calls must come back as budget-exhausted errors, and the loop
  // keeps going to its round bound (degrade, don't kill the stream).
  const four = Array.from({ length: 4 }, (_, i) => ({
    id: `c${i}`,
    name: CALC.name,
    args: JSON.stringify(CALC.args),
  }));
  const seen = stubProvider([openaiToolRound(four)]);
  const events = await collect(makeInput("openai"));

  expect(seen).toHaveLength(7);
  // Exactly MAX_TOOL_CALLS_PER_TURN dispatches happened (trace = real dispatch).
  expect(events.filter((e) => e.type === "trace").length).toBe(MAX_TOOL_CALLS_PER_TURN);
  // Round 5's request (seen[4]) carries round 4's results: all budget errors.
  const round4Results = (seen[4].body.messages as { role: string; content?: string }[])
    .filter((m) => m.role === "tool")
    .slice(-4);
  for (const m of round4Results) {
    expect(m.content).toContain(TOOL_BUDGET_EXHAUSTED_ERROR);
  }
  expect(events.some((e) => e.type === "done")).toBe(true);
});

test("openai: calls beyond the per-round parallel cap get a structured error", async () => {
  const six = Array.from({ length: 6 }, (_, i) => ({
    id: `c${i}`,
    name: CALC.name,
    args: JSON.stringify(CALC.args),
  }));
  const seen = stubProvider([openaiToolRound(six), openaiTextRound("ok")]);
  const events = await collect(makeInput("openai"));

  expect(seen).toHaveLength(2);
  expect(events.filter((e) => e.type === "trace").length).toBe(MAX_PARALLEL_TOOL_CALLS);
  const toolMsgs = (seen[1].body.messages as { role: string; content?: string }[]).filter(
    (m) => m.role === "tool",
  );
  expect(toolMsgs).toHaveLength(6); // every call still gets a result block
  expect(toolMsgs[4].content).toContain(TOOL_PARALLEL_CAP_ERROR);
  expect(toolMsgs[5].content).toContain(TOOL_PARALLEL_CAP_ERROR);
  expect(events.some((e) => e.type === "done")).toBe(true);
});

// ── Malformed args and { error } feedback ───────────────────────────────────

test("openai: malformed JSON args become a structured { error }, never a throw", async () => {
  const seen = stubProvider([
    openaiToolRound([{ id: "c1", name: CALC.name, args: '{"expression":' }]),
    openaiTextRound("recovered"),
  ]);
  const events = await collect(makeInput("openai"));

  const toolMsg = (seen[1].body.messages as { role: string; content?: string }[]).find(
    (m) => m.role === "tool",
  );
  expect(toolMsg?.content).toContain(TOOL_BAD_ARGS_ERROR);
  expect(events.filter((e) => e.type === "trace").length).toBe(0); // never dispatched
  expect(events.some((e) => e.type === "delta" && e.text === "recovered")).toBe(true);
  expect(events.some((e) => e.type === "error")).toBe(false);
});

test("anthropic: malformed JSON args become a structured { error }, never a throw", async () => {
  const seen = stubProvider([
    anthropicToolRound([{ id: "t1", name: CALC.name, json: "{nope" }]),
    anthropicTextRound("recovered"),
  ]);
  const events = await collect(makeInput("anthropic"));

  const msgs = seen[1].body.messages as { role: string; content: unknown }[];
  const block = (msgs[msgs.length - 1].content as { content: string }[])[0];
  expect(block.content).toContain(TOOL_BAD_ARGS_ERROR);
  expect(events.some((e) => e.type === "error")).toBe(false);
  expect(events.some((e) => e.type === "done")).toBe(true);
});

test("an { error } tool result feeds back and the loop continues", async () => {
  // Model calls a tool that doesn't exist: runToolDef returns { error }, the
  // loop feeds it back, and the model synthesizes on the next round.
  const seen = stubProvider([
    openaiToolRound([{ id: "c1", name: "nope__fn", args: "{}" }]),
    openaiTextRound("fell back gracefully"),
  ]);
  const events = await collect(makeInput("openai"));

  const toolMsg = (seen[1].body.messages as { role: string; content?: string }[]).find(
    (m) => m.role === "tool",
  );
  expect(toolMsg?.content).toContain("Unknown tool: nope__fn");
  expect(events.some((e) => e.type === "delta" && e.text === "fell back gracefully")).toBe(true);
  expect(events.some((e) => e.type === "done")).toBe(true);
});

// ── One-seam BYOK hourly budget inside the chat loop ────────────────────────

test("BYOK hourly budget exhausted mid-loop → structured { error }, loop continues", async () => {
  // The budget lives in invokeTool (registry.ts) — the same seam the chat
  // loop dispatches through — so a model turn cannot bypass the bridge's
  // ceiling. social_post (category "social") with limit 1: the round's first
  // call consumes the budget, the second must come back as { error } data
  // and the stream must keep going to a clean done.
  const savedKey = process.env.POSTIZ_API_KEY;
  const savedLimit = process.env.TOOLS_SOCIAL_TOOL_LIMIT;
  process.env.POSTIZ_API_KEY = "pz-test-not-a-real-key";
  process.env.TOOLS_SOCIAL_TOOL_LIMIT = "1";
  try {
    const seen = stubProvider([
      openaiToolRound([
        { id: "c1", name: "social_post__list_channels", args: "{}" },
        { id: "c2", name: "social_post__list_channels", args: "{}" },
      ]),
      openaiTextRound("degraded gracefully"),
    ]);
    const events = await collect(makeInput("openai"));

    const toolMsgs = (seen[seen.length - 1].body.messages as { role: string; content?: string }[])
      .filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    // Second call refused by the shared hourly budget — structured, ours.
    expect(toolMsgs[1].content).toContain("hourly budget");
    // The loop was never killed: it synthesized and finished cleanly.
    expect(events.some((e) => e.type === "delta" && e.text === "degraded gracefully")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  } finally {
    if (savedKey === undefined) delete process.env.POSTIZ_API_KEY;
    else process.env.POSTIZ_API_KEY = savedKey;
    if (savedLimit === undefined) delete process.env.TOOLS_SOCIAL_TOOL_LIMIT;
    else process.env.TOOLS_SOCIAL_TOOL_LIMIT = savedLimit;
  }
});

// ── F11: status line never echoes the model-emitted name ────────────────────

test("unknown tool names show a generic status line, not model prose", async () => {
  stubProvider([
    openaiToolRound([{ id: "c1", name: "nope__fn", args: "{}" }]),
    openaiTextRound("done"),
  ]);
  const events = await collect(makeInput("openai"));
  const statuses = events.filter((e) => e.type === "status").map((e) => ("text" in e ? e.text : ""));
  expect(statuses).toContain("Running tool…");
  expect(statuses.join("|")).not.toContain("nope__fn");
});

// ── F5: fetch rejection → normalized provider error ─────────────────────────

for (const provider of ["anthropic", "openai", "gemini"] as const) {
  test(`${provider}: loop-fetch rejection yields a normalized error, not raw prose`, async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:443");
    }) as typeof fetch;
    const events = await collect(makeInput(provider));
    const err = events.find((e) => e.type === "error");
    expect(err && "error" in err ? err.error : "").toMatch(
      /^(Anthropic|OpenAI|Gemini): could not reach the provider \(network error\)$/,
    );
    expect(JSON.stringify(events)).not.toContain("ECONNREFUSED");
  });
}
