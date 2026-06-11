import {
  manifestToToolDefs,
  runToolDef,
  toolDefStatusText,
  toolDefTraceText,
  type ProviderToolDef,
} from "../tools/defs";
import type { Capability, Provider, Route, Source, StreamEvent } from "../types";

/**
 * Server-side provider adapters. Each yields our unified `StreamEvent`s
 * (start / delta / status / image / sources / done / error), translating the
 * native streaming format of the interpret backend or a direct provider call.
 * Keys come from the request (BYO) or fall back to server env. Secrets never
 * leave the server.
 *
 * Beyond plain chat, each provider's server-side "agent" tools are passed
 * through here so ProperChat reaches the same functionality the first-party
 * apps do: web search (all three), image generation (OpenAI image_generation,
 * Gemini image models), code interpreter (OpenAI/Anthropic/Gemini), and deep
 * research (OpenAI deep-research models). The exact request/stream contracts
 * were verified against current provider docs (see capability dispatch below).
 */

export interface DispatchInput {
  route: Route;
  provider: Provider;
  /** Concrete id: interpret tier (route=interpret) or provider model id (route=direct). */
  model: string;
  system: string;
  messages: {
    role: "user" | "assistant";
    content: string;
    image_urls?: string[];
    documents?: { url: string; mime: string }[];
  }[];
  maxTokens: number;
  temperature?: number;
  /** Gemini thinking budget passthrough: 0 off, -1 dynamic, >0 cap; omit for the
   * backend's per-model default. Only consumed by the interpret Gemini path. */
  thinkingBudget?: number;
  /** Provider-native capability for this turn. Anything other than "chat" forces a direct call. */
  capability?: Capability;
  keys: {
    interpret?: string;
    anthropic?: string;
    openai?: string;
    gemini?: string;
  };
}

const INTERPRET_BASE =
  process.env.INTERPRET_API_BASE?.replace(/\/$/, "") ||
  "https://staging.interpretai.tech";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** Parse an upstream SSE body into JSON objects from each `data:` frame. */
async function* iterateSSE(res: Response): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseFrame = function* (frame: string) {
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      yield JSON.parse(data) as Record<string, unknown>;
    } catch {
      /* skip keepalives / partial */
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      yield* parseFrame(frame);
    }
  }
  if (buffer.trim()) yield* parseFrame(buffer);
}

async function errorText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      const detail =
        json?.error?.message ?? json?.detail ?? json?.error ?? json?.message;
      if (detail) return typeof detail === "string" ? detail : JSON.stringify(detail);
    } catch {
      /* not json */
    }
    return text.slice(0, 500) || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// --------------------------------------------------------------------------
// Document (PDF) passthrough. A document arrives as a `data:` URL (base64) or
// an http(s) URL. Each provider reads PDFs natively but wants a different block
// shape; these builders translate one document into the right native form
// (verified against current provider docs).
// --------------------------------------------------------------------------

type DocRef = { url: string; mime: string };

/** Split a `data:<mime>;base64,<data>` URL into its media type and base64 payload. */
function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
  if (!m || !m[2]) return null; // only base64 data URLs carry raw bytes we can forward
  return { mediaType: m[1] || "application/octet-stream", data: m[3] };
}

/** Anthropic `document` content block: base64 source for data: URLs, else url source. */
function anthropicDocumentBlock(doc: DocRef): Record<string, unknown> {
  const parsed = doc.url.startsWith("data:") ? parseDataUrl(doc.url) : null;
  const source = parsed
    ? { type: "base64", media_type: doc.mime || parsed.mediaType || "application/pdf", data: parsed.data }
    : { type: "url", url: doc.url };
  return { type: "document", source };
}

/** OpenAI chat/completions `file` part (base64 data URL via file_data). */
function openaiFileBlock(doc: DocRef): Record<string, unknown> {
  return { type: "file", file: { filename: "document.pdf", file_data: doc.url } };
}

/** Gemini part: inline_data (base64) for data: URLs, else file_data with a uri. */
function geminiDocumentPart(doc: DocRef): Record<string, unknown> {
  const parsed = doc.url.startsWith("data:") ? parseDataUrl(doc.url) : null;
  return parsed
    ? { inline_data: { mime_type: doc.mime || parsed.mediaType || "application/pdf", data: parsed.data } }
    : { file_data: { file_uri: doc.url, mime_type: doc.mime || "application/pdf" } };
}

/** Whether a turn carries any attached media (images or documents). */
function hasMedia(m: DispatchInput["messages"][number]): boolean {
  return Boolean(m.image_urls?.length) || Boolean(m.documents?.length);
}

// --------------------------------------------------------------------------
// interpret backend (staging.interpretai.tech)
// --------------------------------------------------------------------------
async function* interpretStream(input: DispatchInput): AsyncGenerator<StreamEvent> {
  const key = input.keys.interpret || env("INTERPRETAI_API_KEY");
  if (!key) {
    // For a signed-in user this means provisioning failed upstream (e.g. the
    // IAI backend errored while minting their key), not a missing local config.
    // Log the real cause server-side; give the user something actionable.
    console.error(
      "[interpretStream] no interpret credential resolved (per-user provisioning failed or unconfigured)",
    );
    yield {
      type: "error",
      error:
        "Could not reach InterpretAI right now. This is usually temporary, please try again. If it keeps happening, contact hello@interpretai.tech.",
    };
    return;
  }
  const res = await fetch(`${INTERPRET_BASE}/api/v1/ai/models/messages/stream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      system: input.system || "",
      // The interpret ChatTurn carries only text + image_urls; never leak
      // `documents` here (PDF turns are forced to a direct provider call, but a
      // PDF left in history could otherwise ride along on a later interpret turn).
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.image_urls?.length ? { image_urls: m.image_urls } : {}),
      })),
      max_tokens: input.maxTokens,
      ...(input.temperature != null ? { temperature: input.temperature } : {}),
      ...(input.thinkingBudget != null ? { thinking_budget: input.thinkingBudget } : {}),
      persist_convo: false,
    }),
  });
  if (!res.ok) {
    const detail = await errorText(res);
    console.error(
      `[interpretStream] ${INTERPRET_BASE}/api/v1/ai/models/messages/stream -> ${res.status}: ${detail.slice(0, 500)}`,
    );
    // 5xx is our problem, not the user's: don't leak a stack/"Internal Server
    // Error" blob, point them at support. 4xx (bad request, quota) keeps detail.
    yield {
      type: "error",
      error:
        res.status >= 500
          ? "InterpretAI hit an internal error. Please try again, and contact hello@interpretai.tech if it persists."
          : `InterpretAI request failed: ${detail}`,
    };
    return;
  }
  let started = false;
  for await (const ev of iterateSSE(res)) {
    const t = ev.type as string;
    if (t === "start") {
      started = true;
      yield {
        type: "start",
        provider: input.provider,
        route: "interpret",
        model: (ev.model_id as string) || input.model,
      };
    } else if (t === "delta") {
      if (!started) {
        started = true;
        yield { type: "start", provider: input.provider, route: "interpret", model: input.model };
      }
      yield { type: "delta", text: (ev.text as string) || "" };
    } else if (t === "image") {
      // The interpret backend forwards provider-generated images verbatim as
      // an `image` event — base64 bytes (`b64`/`data`) or a remote `url`.
      // Tolerate either shape (and snake/camel mime keys) so it renders the
      // same way the direct OpenAI/Gemini image adapters do.
      const b64 = (ev.b64 as string) || (ev.data as string) || (ev.image_b64 as string) || "";
      const url = (ev.url as string) || (ev.image_url as string) || "";
      const mime = (ev.mime as string) || (ev.mime_type as string) || "image/png";
      if (b64 || url) {
        if (!started) {
          started = true;
          yield { type: "start", provider: input.provider, route: "interpret", model: input.model };
        }
        yield { type: "image", ...(b64 ? { b64 } : {}), ...(url ? { url } : {}), mime };
      }
    } else if (t === "done") {
      const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      yield {
        type: "done",
        usage: { input: usage?.input_tokens, output: usage?.output_tokens },
        stopReason: (ev.stop_reason as string) ?? null,
      };
    } else if (t === "error") {
      yield { type: "error", error: (ev.error as string) || "Interpret stream error" };
    }
    // "persisted" is ignored - we never persist server-side.
  }
}

// --------------------------------------------------------------------------
// Community (marketplace) tools — TOOL_MARKETPLACE.md M2. Every registered
// webhook manifest becomes a model-callable function (`<toolId>__<fn>`) on
// *direct chat* turns; the adapters below translate the provider-agnostic
// defs to each native tool format and run an agentic loop: tool-call event →
// dispatch through the same registry seam as /api/tools/[tool] → result back
// to the model → continue. Scope decisions:
//
// - Chat capability only: capability turns (web_search/image/…) already carry
//   provider *server* tools with their own stream semantics; mixing client
//   tools in is a separate step. The interpret route is untouched (its
//   backend speaks plain messages).
// - Union degradation: `manifestToToolDefs()` strips unconfigured/BYOK-missing
//   bindings per request — the model never sees them, nothing 4xxes mid-loop.
// - Bounded rounds: a turn runs at most COMMUNITY_TOOL_ROUNDS tool rounds,
//   then the last response stands (agent loops must terminate).
// --------------------------------------------------------------------------

const COMMUNITY_TOOL_ROUNDS = 6;
/** Hard cap on dispatched tool calls across ALL rounds of one turn. */
export const MAX_TOOL_CALLS_PER_TURN = 12;
/** Hard cap on dispatched tool calls within ONE round (parallel calls). */
export const MAX_PARALLEL_TOOL_CALLS = 4;

export const TOOL_BUDGET_EXHAUSTED_ERROR = "tool budget for this turn exhausted";
export const TOOL_PARALLEL_CAP_ERROR = `too many parallel tool calls in one round (max ${MAX_PARALLEL_TOOL_CALLS})`;
export const TOOL_BAD_ARGS_ERROR = "tool call arguments were not valid JSON";

/**
 * Per-turn invocation budget (one instance per adapter turn). The metering
 * counter in registry.ts only *observes*; this is what actually throttles a
 * runaway or hostile model. Mirrors union degradation: an over-budget call
 * gets a structured `{ error }` result and the loop keeps going so the model
 * can synthesize — the stream is never killed.
 */
function createToolBudget() {
  let used = 0;
  return {
    /** Try to spend one call slot; `indexInRound` is 0-based within the round. */
    take(indexInRound: number): { ok: true } | { ok: false; error: string } {
      if (indexInRound >= MAX_PARALLEL_TOOL_CALLS) {
        return { ok: false, error: TOOL_PARALLEL_CAP_ERROR };
      }
      if (used >= MAX_TOOL_CALLS_PER_TURN) {
        return { ok: false, error: TOOL_BUDGET_EXHAUSTED_ERROR };
      }
      used++;
      return { ok: true };
    },
  };
}
type ToolBudget = ReturnType<typeof createToolBudget>;

/**
 * Run one budgeted community tool call. Yields the status/trace events (with
 * the model-emitted name resolved against the registry — never echoed
 * verbatim) and returns the result data to feed back to the model. `args` is
 * null when the model emitted malformed JSON: that becomes a structured
 * `{ error }` without dispatching and without spending budget.
 */
async function* runBudgetedToolCall(
  budget: ToolBudget,
  indexInRound: number,
  name: string,
  args: Record<string, unknown> | null,
): AsyncGenerator<StreamEvent, unknown> {
  if (args === null) return { error: TOOL_BAD_ARGS_ERROR };
  const gate = budget.take(indexInRound);
  if (!gate.ok) return { error: gate.error };
  yield { type: "status", text: toolDefStatusText(name) };
  const result = await runToolDef(name, args);
  yield { type: "trace", text: toolDefTraceText(name) };
  return result;
}

function communityToolDefs(cap: Capability): ProviderToolDef[] {
  return cap === "chat" ? manifestToToolDefs() : [];
}

/** Gemini `functionResponse.response` must be a JSON *object*; wrap others. */
function asResponseObject(result: unknown): Record<string, unknown> {
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { result: result ?? null };
}

/**
 * Server-tool config for an Anthropic capability turn. Tool version strings and
 * the code-execution beta header are verified against docs.anthropic.com.
 */
function anthropicTools(cap: Capability): {
  tools?: Record<string, unknown>[];
  beta?: string;
} {
  switch (cap) {
    case "web_search":
      // GA; no beta header. `_20250305` works on every model.
      return { tools: [{ type: "web_search_20250305", name: "web_search" }] };
    case "code":
      return {
        tools: [{ type: "code_execution_20250825", name: "code_execution" }],
        beta: "code-execution-2025-08-25",
      };
    default:
      // image / deep_research aren't Anthropic server tools; the resolver never
      // routes them here, so plain chat is the right fallback.
      return {};
  }
}

// --------------------------------------------------------------------------
// Anthropic - direct /v1/messages (chat + web search + code execution)
// --------------------------------------------------------------------------
async function* anthropicStream(input: DispatchInput): AsyncGenerator<StreamEvent> {
  const key = input.keys.anthropic || env("ANTHROPIC_API_KEY");
  if (!key) {
    yield { type: "error", error: "No Anthropic API key. Add one in Settings to use Claude directly." };
    return;
  }
  yield { type: "start", provider: "anthropic", route: "direct", model: input.model };

  const { tools, beta } = anthropicTools(input.capability ?? "chat");
  // Community (marketplace) client tools ride along on chat turns, in
  // Anthropic's custom-tool shape ({ name, description, input_schema }).
  const communityTools = communityToolDefs(input.capability ?? "chat").map((d) => ({
    name: d.name,
    description: d.description,
    input_schema: d.parameters,
  }));
  const allTools = [...(tools ?? []), ...communityTools];
  const headers: Record<string, string> = {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (beta) headers["anthropic-beta"] = beta;

  // Mutable native message list so tool rounds can append turns.
  const msgs: Record<string, unknown>[] = input.messages.map((m) =>
    hasMedia(m)
      ? {
          role: m.role,
          content: [
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...(m.image_urls ?? []).map((url) => ({ type: "image", source: { type: "url", url } })),
            ...(m.documents ?? []).map(anthropicDocumentBlock),
          ],
        }
      : { role: m.role, content: m.content },
  );

  let stopReason: string | null = null;
  let outTokens: number | undefined;
  let inTokens: number | undefined;

  const budget = createToolBudget();
  for (let round = 0; round <= COMMUNITY_TOOL_ROUNDS; round++) {
    // F3: the final round exists only to synthesize — a tool_use there could
    // never dispatch, so community tools are not offered on it. Server tools
    // (web_search/code on capability turns) keep their provider-side semantics.
    const roundTools = round < COMMUNITY_TOOL_ROUNDS ? allTools : tools ?? [];
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: input.model,
          ...(input.system ? { system: input.system } : {}),
          messages: msgs,
          max_tokens: input.maxTokens,
          ...(roundTools.length ? { tools: roundTools } : {}),
          // `temperature` is deprecated on the Claude 4.x line (returns 400), so we
          // omit it for Anthropic and let the model use its default.
          stream: true,
        }),
      });
    } catch {
      // Normalized copy only — raw fetch rejection prose never reaches the stream.
      yield { type: "error", error: "Anthropic: could not reach the provider (network error)" };
      return;
    }
    if (!res.ok) {
      yield { type: "error", error: `Anthropic: ${await errorText(res)}` };
      return;
    }
    stopReason = null;
    // Track server_tool_use blocks so we can surface the search query as a trace,
    // and client tool_use blocks so we can dispatch them through the registry.
    const toolBlocks = new Map<number, { name: string; json: string }>();
    const clientCalls: { id: string; name: string; json: string }[] = [];
    const clientBlockIdx = new Map<number, number>(); // stream index → clientCalls index
    let textAcc = "";
    for await (const ev of iterateSSE(res)) {
      const t = ev.type as string;
      if (t === "message_start") {
        const usage = (ev.message as { usage?: { input_tokens?: number } })?.usage;
        if (usage?.input_tokens != null) inTokens = (inTokens ?? 0) + usage.input_tokens;
      } else if (t === "content_block_start") {
        const idx = ev.index as number;
        const block = ev.content_block as
          | { type?: string; id?: string; name?: string; content?: { url?: string; title?: string }[] }
          | undefined;
        if (block?.type === "server_tool_use" && block.name) {
          toolBlocks.set(idx, { name: block.name, json: "" });
        }
        if (block?.type === "tool_use" && block.name && block.id) {
          clientBlockIdx.set(idx, clientCalls.length);
          clientCalls.push({ id: block.id, name: block.name, json: "" });
        }
        // Web-search results arrive whole in the block-start event.
        if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
          const sources: Source[] = block.content
            .filter((r) => r?.url)
            .map((r) => ({ url: r.url as string, title: r.title }));
          if (sources.length) yield { type: "sources", sources };
        }
      } else if (t === "content_block_delta") {
        const idx = ev.index as number;
        const delta = ev.delta as {
          type?: string;
          text?: string;
          partial_json?: string;
          citation?: { url?: string; title?: string };
        };
        if (delta?.type === "text_delta" && delta.text) {
          textAcc += delta.text;
          yield { type: "delta", text: delta.text };
        } else if (delta?.type === "citations_delta" && delta.citation?.url) {
          yield { type: "sources", sources: [{ url: delta.citation.url, title: delta.citation.title }] };
        } else if (delta?.type === "input_json_delta") {
          if (toolBlocks.has(idx)) toolBlocks.get(idx)!.json += delta.partial_json ?? "";
          const ci = clientBlockIdx.get(idx);
          if (ci != null) clientCalls[ci].json += delta.partial_json ?? "";
        }
      } else if (t === "content_block_stop") {
        const idx = ev.index as number;
        const tb = toolBlocks.get(idx);
        if (tb?.name === "web_search") {
          let query: string | undefined;
          try {
            query = (JSON.parse(tb.json) as { query?: string }).query;
          } catch {
            /* partial / non-json */
          }
          yield { type: "trace", text: query ? `Searched the web for “${query}”` : "Searched the web" };
        } else if (tb?.name === "code_execution") {
          yield { type: "trace", text: "Ran code in the sandbox" };
        }
      } else if (t === "message_delta") {
        const delta = ev.delta as { stop_reason?: string };
        const usage = ev.usage as { output_tokens?: number } | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        if (usage?.output_tokens != null) outTokens = (outTokens ?? 0) + usage.output_tokens;
      } else if (t === "error") {
        const e = ev.error as { message?: string } | undefined;
        yield { type: "error", error: `Anthropic: ${e?.message || "stream error"}` };
        return;
      }
    }

    if (stopReason !== "tool_use" || !clientCalls.length || round === COMMUNITY_TOOL_ROUNDS) break;

    // Tool round: replay the assistant turn, dispatch each call through the
    // registry seam (same one /api/tools uses), feed results back, continue.
    // Malformed JSON args → `args: null` → structured { error }, never a throw.
    const parsedCalls = clientCalls.map((c) => {
      let args: Record<string, unknown> | null = null;
      try {
        args = c.json ? (JSON.parse(c.json) as Record<string, unknown>) : {};
      } catch {
        /* model emitted malformed json */
      }
      return { id: c.id, name: c.name, args };
    });
    msgs.push({
      role: "assistant",
      content: [
        ...(textAcc ? [{ type: "text", text: textAcc }] : []),
        // The replayed tool_use block needs a JSON object even when args were malformed.
        ...parsedCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} })),
      ],
    });
    const resultBlocks: Record<string, unknown>[] = [];
    for (let i = 0; i < parsedCalls.length; i++) {
      const call = parsedCalls[i];
      const result = yield* runBudgetedToolCall(budget, i, call.name, call.args);
      resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) });
    }
    msgs.push({ role: "user", content: resultBlocks });
  }
  yield { type: "done", usage: { input: inTokens, output: outTokens }, stopReason };
}

// --------------------------------------------------------------------------
// OpenAI - direct /v1/chat/completions
// --------------------------------------------------------------------------
async function* openaiStream(input: DispatchInput): AsyncGenerator<StreamEvent> {
  const key = input.keys.openai || env("OPENAI_API_KEY");
  if (!key) {
    yield { type: "error", error: "No OpenAI API key. Add one in Settings to use ChatGPT directly." };
    return;
  }
  yield { type: "start", provider: "openai", route: "direct", model: input.model };

  // gpt-5 / o-series are reasoning models: they require max_completion_tokens
  // and reject a non-default temperature.
  const isReasoning = /^(o\d|gpt-5)/.test(input.model);
  // Mutable native message list so community-tool rounds can append turns.
  const messages: Record<string, unknown>[] = [
    ...(input.system ? [{ role: "system", content: input.system }] : []),
    ...input.messages.map((m) =>
      hasMedia(m)
        ? {
            role: m.role,
            content: [
              ...(m.content ? [{ type: "text", text: m.content }] : []),
              ...(m.image_urls ?? []).map((url) => ({ type: "image_url", image_url: { url } })),
              ...(m.documents ?? []).map(openaiFileBlock),
            ],
          }
        : { role: m.role, content: m.content },
    ),
  ];
  // Community (marketplace) client tools, in chat/completions function shape.
  const communityTools = communityToolDefs(input.capability ?? "chat").map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));

  let stopReason: string | null = null;
  let usage: { input?: number; output?: number } | undefined;

  const budget = createToolBudget();
  for (let round = 0; round <= COMMUNITY_TOOL_ROUNDS; round++) {
    const body: Record<string, unknown> = {
      model: input.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      // F3: the final round can never dispatch, so it gets no tools at all.
      ...(round < COMMUNITY_TOOL_ROUNDS && communityTools.length ? { tools: communityTools } : {}),
    };
    if (isReasoning) {
      body.max_completion_tokens = input.maxTokens;
    } else {
      body.max_tokens = input.maxTokens;
      if (input.temperature != null) body.temperature = input.temperature;
    }

    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // Normalized copy only — raw fetch rejection prose never reaches the stream.
      yield { type: "error", error: "OpenAI: could not reach the provider (network error)" };
      return;
    }
    if (!res.ok) {
      yield { type: "error", error: `OpenAI: ${await errorText(res)}` };
      return;
    }
    stopReason = null;
    let textAcc = "";
    // Accumulate streamed tool_calls deltas by index.
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of iterateSSE(res)) {
      const choices = chunk.choices as
        | {
            delta?: {
              content?: string;
              tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
            finish_reason?: string | null;
          }[]
        | undefined;
      const choice = choices?.[0];
      if (choice?.delta?.content) {
        textAcc += choice.delta.content;
        yield { type: "delta", text: choice.delta.content };
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (u) {
        usage = {
          input: (usage?.input ?? 0) + (u.prompt_tokens ?? 0),
          output: (usage?.output ?? 0) + (u.completion_tokens ?? 0),
        };
      }
    }

    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    if (stopReason !== "tool_calls" || !toolCalls.length || round === COMMUNITY_TOOL_ROUNDS) break;

    // Tool round: replay the assistant turn, dispatch through the registry
    // seam, append per-call tool results, continue the loop.
    messages.push({
      role: "assistant",
      content: textAcc || null,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args || "{}" },
      })),
    });
    for (let i = 0; i < toolCalls.length; i++) {
      const c = toolCalls[i];
      // Malformed JSON args → null → structured { error }, never a throw.
      let args: Record<string, unknown> | null = null;
      try {
        args = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {};
      } catch {
        /* model emitted malformed json */
      }
      const result = yield* runBudgetedToolCall(budget, i, c.name, args);
      messages.push({
        role: "tool",
        tool_call_id: c.id,
        content: JSON.stringify(result),
      });
    }
  }
  yield { type: "done", usage, stopReason };
}

// --------------------------------------------------------------------------
// OpenAI - direct /v1/responses (capability turns: web search, image,
// deep research, code interpreter). Event/field names verified against the
// current Responses API streaming contract.
// --------------------------------------------------------------------------
function openaiResponsesTools(cap: Capability, model: string): Record<string, unknown>[] {
  switch (cap) {
    case "web_search":
      return [{ type: "web_search" }];
    case "deep_research":
      // Deep-research models require a data source; their docs use web_search_preview.
      return [{ type: "web_search_preview" }];
    case "image":
      return [{ type: "image_generation", partial_images: 2 }];
    case "code":
      return [{ type: "code_interpreter", container: { type: "auto" } }];
    default:
      void model;
      return [];
  }
}

async function* openaiResponsesStream(input: DispatchInput): AsyncGenerator<StreamEvent> {
  const key = input.keys.openai || env("OPENAI_API_KEY");
  if (!key) {
    yield { type: "error", error: "No OpenAI API key. Add one in Settings to use ChatGPT tools." };
    return;
  }
  yield { type: "start", provider: "openai", route: "direct", model: input.model };

  const cap = input.capability ?? "chat";
  const tools = openaiResponsesTools(cap, input.model);
  // Deep research can consume a large reasoning budget; give it real headroom.
  const maxOut = cap === "deep_research" ? Math.max(input.maxTokens, 16000) : Math.max(input.maxTokens, 1024);
  // Reasoning models (o-series, gpt-5, deep research) can stream a thinking
  // summary; ask for it so the UI can show the trace.
  const wantsReasoning = /deep-research|^o\d|^gpt-5/.test(input.model);

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      ...(input.system ? { instructions: input.system } : {}),
      input: input.messages.map((m) => {
        const textType = m.role === "user" ? "input_text" : "output_text";
        if (m.image_urls?.length) {
          return {
            role: m.role,
            content: [
              ...(m.content ? [{ type: textType, text: m.content }] : []),
              ...m.image_urls.map((url) => ({ type: "input_image", image_url: url })),
            ],
          };
        }
        return { role: m.role, content: m.content };
      }),
      stream: true,
      max_output_tokens: maxOut,
      ...(wantsReasoning ? { reasoning: { summary: "auto" } } : {}),
      ...(tools.length ? { tools } : {}),
    }),
  });
  if (!res.ok) {
    yield { type: "error", error: `OpenAI: ${await errorText(res)}` };
    return;
  }

  let usage: { input?: number; output?: number } | undefined;
  let stopReason: string | null = null;
  for await (const ev of iterateSSE(res)) {
    const t = ev.type as string;
    if (t === "response.output_text.delta") {
      if (typeof ev.delta === "string") yield { type: "delta", text: ev.delta };
    } else if (t.includes("reasoning_summary") && t.endsWith(".delta")) {
      // response.reasoning_summary_text.delta -> thinking trace
      if (typeof ev.delta === "string") yield { type: "reasoning", text: ev.delta };
    } else if (t.includes("annotation") && ev.annotation) {
      // response.output_text.annotation.added -> url_citation
      const a = ev.annotation as { url?: string; title?: string };
      if (a?.url) yield { type: "sources", sources: [{ url: a.url, title: a.title }] };
    } else if (t === "response.image_generation_call.partial_image") {
      yield { type: "status", text: "Rendering image…" };
    } else if (t === "response.output_item.added") {
      const it = ev.item as { type?: string } | undefined;
      if (it?.type === "web_search_call") yield { type: "status", text: "Searching the web…" };
      else if (it?.type === "image_generation_call") yield { type: "status", text: "Generating image…" };
      else if (it?.type === "code_interpreter_call") yield { type: "status", text: "Running code…" };
    } else if (t === "response.output_item.done") {
      const it = ev.item as
        | { type?: string; result?: string; action?: { query?: string; url?: string } }
        | undefined;
      // Final full-resolution image lives on the image_generation_call item's `result`.
      if (it?.type === "image_generation_call" && it.result) {
        yield { type: "image", b64: it.result, mime: "image/png" };
      } else if (it?.type === "web_search_call") {
        const q = it.action?.query;
        yield { type: "trace", text: q ? `Searched the web for “${q}”` : "Searched the web" };
      } else if (it?.type === "code_interpreter_call") {
        yield { type: "trace", text: "Ran code in the sandbox" };
      }
    } else if (t === "response.completed") {
      const r = ev.response as
        | { usage?: { input_tokens?: number; output_tokens?: number } }
        | undefined;
      usage = { input: r?.usage?.input_tokens, output: r?.usage?.output_tokens };
      if (!stopReason) stopReason = "stop";
    } else if (t === "response.incomplete") {
      const r = ev.response as { incomplete_details?: { reason?: string } } | undefined;
      stopReason = r?.incomplete_details?.reason ?? "incomplete";
    } else if (t === "response.failed") {
      const r = ev.response as { error?: { message?: string } } | undefined;
      yield { type: "error", error: `OpenAI: ${r?.error?.message || "response failed"}` };
      return;
    } else if (t === "error") {
      const e = ev as { message?: string };
      yield { type: "error", error: `OpenAI: ${e.message || "stream error"}` };
      return;
    }
  }
  yield { type: "done", usage, stopReason };
}

/** Gemini message contents, shared by the streaming and image paths. */
function geminiContents(input: DispatchInput) {
  return input.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [
      ...(m.content ? [{ text: m.content }] : []),
      ...(m.image_urls ?? []).map((url) => ({
        file_data: { file_uri: url, mime_type: "image/jpeg" },
      })),
      ...(m.documents ?? []).map(geminiDocumentPart),
    ],
  }));
}

/** Gemini response part — tolerates both camelCase (wire) and snake_case (SDK-style) keys. */
interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
  executableCode?: { language?: string; code?: string };
  executable_code?: { language?: string; code?: string };
  codeExecutionResult?: { outcome?: string; output?: string };
  code_execution_result?: { outcome?: string; output?: string };
  functionCall?: { name?: string; args?: Record<string, unknown> };
  function_call?: { name?: string; args?: Record<string, unknown> };
}

/** Turn an executable-code / code-result part into rendered markdown. */
function geminiCodePartText(p: GeminiPart): string | null {
  const ec = p.executableCode ?? p.executable_code;
  if (ec?.code) {
    const lang = (ec.language ?? "").toLowerCase();
    return `\n\n\`\`\`${lang}\n${ec.code}\n\`\`\`\n`;
  }
  const cr = p.codeExecutionResult ?? p.code_execution_result;
  if (cr?.output) return `\n\n\`\`\`\n${cr.output}\n\`\`\`\n`;
  return null;
}

/** Server-tool config for a Gemini capability turn. */
function geminiTools(cap: Capability): Record<string, unknown>[] | undefined {
  if (cap === "web_search") return [{ google_search: {} }];
  if (cap === "code") return [{ code_execution: {} }];
  return undefined;
}

// --------------------------------------------------------------------------
// Gemini - non-streaming image generation (Nano Banana image models).
// The image models have no documented streaming path, so we call
// :generateContent and emit the inline image parts.
// --------------------------------------------------------------------------
async function* geminiImageGenerate(input: DispatchInput, key: string): AsyncGenerator<StreamEvent> {
  yield { type: "status", text: "Generating image…" };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    input.model,
  )}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: geminiContents(input),
      ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  });
  if (!res.ok) {
    yield { type: "error", error: `Gemini: ${await errorText(res)}` };
    return;
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const cand = data.candidates?.[0];
  for (const p of cand?.content?.parts ?? []) {
    if (p.text) yield { type: "delta", text: p.text };
    const inline = p.inlineData ?? p.inline_data;
    if (inline?.data) {
      const mime =
        (inline as { mimeType?: string }).mimeType ??
        (inline as { mime_type?: string }).mime_type ??
        "image/png";
      yield { type: "image", b64: inline.data, mime };
    }
  }
  yield {
    type: "done",
    usage: { input: data.usageMetadata?.promptTokenCount, output: data.usageMetadata?.candidatesTokenCount },
    stopReason: cand?.finishReason ?? null,
  };
}

// --------------------------------------------------------------------------
// Gemini - direct streamGenerateContent (chat + Google Search + code exec)
// --------------------------------------------------------------------------
async function* geminiStream(input: DispatchInput): AsyncGenerator<StreamEvent> {
  const key = input.keys.gemini || env("GEMINI_API_KEY");
  if (!key) {
    yield { type: "error", error: "No Google AI key. Add one in Settings to use Gemini directly." };
    return;
  }
  const cap = input.capability ?? "chat";
  if (cap === "image") {
    yield { type: "start", provider: "gemini", route: "direct", model: input.model };
    yield* geminiImageGenerate(input, key);
    return;
  }

  yield { type: "start", provider: "gemini", route: "direct", model: input.model };
  const serverTools = geminiTools(cap) ?? [];
  // Community (marketplace) client tools, as Gemini function declarations.
  const communityDefs = communityToolDefs(cap);
  const communityDecl = communityDefs.length
    ? {
        function_declarations: communityDefs.map((d) => ({
          name: d.name,
          description: d.description,
          parameters: d.parameters,
        })),
      }
    : null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    input.model,
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

  // Mutable contents list so community-tool rounds can append turns.
  const contents: Record<string, unknown>[] = geminiContents(input);
  let usage: { input?: number; output?: number } | undefined;
  let stopReason: string | null = null;
  const seenSources = new Set<string>();
  const seenQueries = new Set<string>();

  const budget = createToolBudget();
  for (let round = 0; round <= COMMUNITY_TOOL_ROUNDS; round++) {
    // F3: the final round can never dispatch — community declarations are not
    // offered on it. Server tools (search/code) keep provider-side semantics.
    const roundTools =
      round < COMMUNITY_TOOL_ROUNDS && communityDecl
        ? [...serverTools, communityDecl]
        : serverTools;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
          ...(roundTools.length ? { tools: roundTools } : {}),
          generationConfig: {
            maxOutputTokens: input.maxTokens,
            ...(input.temperature != null ? { temperature: input.temperature } : {}),
          },
        }),
      });
    } catch {
      // Normalized copy only — raw fetch rejection prose never reaches the stream.
      yield { type: "error", error: "Gemini: could not reach the provider (network error)" };
      return;
    }
    if (!res.ok) {
      yield { type: "error", error: `Gemini: ${await errorText(res)}` };
      return;
    }
    stopReason = null;
    let textAcc = "";
    const funcCalls: { name: string; args: Record<string, unknown> }[] = [];
    for await (const chunk of iterateSSE(res)) {
      const candidates = chunk.candidates as
        | {
            content?: { parts?: GeminiPart[] };
            finishReason?: string;
            groundingMetadata?: {
              groundingChunks?: { web?: { uri?: string; title?: string } }[];
              webSearchQueries?: string[];
            };
          }[]
        | undefined;
      const cand = candidates?.[0];
      const parts = cand?.content?.parts;
      if (parts) {
        for (const p of parts) {
          if (p.text) {
            textAcc += p.text;
            yield { type: "delta", text: p.text };
          }
          const code = geminiCodePartText(p);
          if (code) yield { type: "delta", text: code };
          const fc = p.functionCall ?? p.function_call;
          if (fc?.name) funcCalls.push({ name: fc.name, args: fc.args ?? {} });
        }
      }
      // Surface the search queries Gemini ran as activity traces.
      for (const q of cand?.groundingMetadata?.webSearchQueries ?? []) {
        if (q && !seenQueries.has(q)) {
          seenQueries.add(q);
          yield { type: "trace", text: `Searched the web for “${q}”` };
        }
      }
      // Grounding citations accumulate across chunks; emit the new ones.
      const grounding = cand?.groundingMetadata?.groundingChunks;
      if (grounding?.length) {
        const sources: Source[] = [];
        for (const g of grounding) {
          const uri = g.web?.uri;
          if (uri && !seenSources.has(uri)) {
            seenSources.add(uri);
            sources.push({ url: uri, title: g.web?.title });
          }
        }
        if (sources.length) yield { type: "sources", sources };
      }
      if (cand?.finishReason) stopReason = cand.finishReason;
      const meta = chunk.usageMetadata as
        | { promptTokenCount?: number; candidatesTokenCount?: number }
        | undefined;
      if (meta) {
        usage = {
          input: (usage?.input ?? 0) + (meta.promptTokenCount ?? 0),
          output: (usage?.output ?? 0) + (meta.candidatesTokenCount ?? 0),
        };
      }
    }

    if (!funcCalls.length || round === COMMUNITY_TOOL_ROUNDS) break;

    // Tool round: replay the model turn, dispatch through the registry seam,
    // append functionResponse parts, continue the loop.
    contents.push({
      role: "model",
      parts: [
        ...(textAcc ? [{ text: textAcc }] : []),
        ...funcCalls.map((c) => ({ function_call: { name: c.name, args: c.args } })),
      ],
    });
    const responseParts: Record<string, unknown>[] = [];
    for (let i = 0; i < funcCalls.length; i++) {
      const c = funcCalls[i];
      // Gemini delivers args pre-parsed, so malformed-JSON can't occur here.
      const result = yield* runBudgetedToolCall(budget, i, c.name, c.args);
      responseParts.push({
        function_response: { name: c.name, response: asResponseObject(result) },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }
  yield { type: "done", usage, stopReason };
}

/** Route a request to the correct adapter. */
export function dispatch(input: DispatchInput): AsyncGenerator<StreamEvent> {
  const cap = input.capability ?? "chat";
  // Capability turns require a provider's native tools, which only the direct
  // provider APIs expose (the interpret backend speaks plain messages only).
  if (cap !== "chat") {
    switch (input.provider) {
      case "openai":
        return openaiResponsesStream(input);
      case "anthropic":
        return anthropicStream(input);
      case "gemini":
        return geminiStream(input);
      default:
        return openaiResponsesStream(input);
    }
  }
  if (input.route === "interpret") return interpretStream(input);
  switch (input.provider) {
    case "anthropic":
      return anthropicStream(input);
    case "openai":
      return openaiStream(input);
    case "gemini":
      return geminiStream(input);
    default:
      return interpretStream(input);
  }
}

/**
 * Whether this request will use one of OUR server-side keys (the per-user
 * provisioned interpret key, or a server env provider key) rather than a
 * client-supplied BYO key. Mirrors `dispatch`'s credential selection so the two
 * never diverge. BYO calls are exempt from our quota; server-key calls are
 * metered and capped.
 */
export function usesServerKey(input: DispatchInput): boolean {
  const cap = input.capability ?? "chat";
  // Capability turns always force a direct provider call.
  if (cap !== "chat") return !input.keys[input.provider];
  if (input.route === "interpret") return !input.keys.interpret;
  switch (input.provider) {
    case "anthropic":
    case "openai":
    case "gemini":
      return !input.keys[input.provider];
    default:
      return !input.keys.interpret;
  }
}

/** Which providers have a usable server-side key (booleans only). */
export function serverKeyAvailability() {
  return {
    interpret: Boolean(env("INTERPRETAI_API_KEY")),
    anthropic: Boolean(env("ANTHROPIC_API_KEY")),
    openai: Boolean(env("OPENAI_API_KEY")),
    gemini: Boolean(env("GEMINI_API_KEY")),
  };
}
