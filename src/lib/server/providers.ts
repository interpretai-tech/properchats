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
  messages: { role: "user" | "assistant"; content: string; image_urls?: string[] }[];
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
      messages: input.messages,
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
  const headers: Record<string, string> = {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (beta) headers["anthropic-beta"] = beta;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: input.model,
      ...(input.system ? { system: input.system } : {}),
      messages: input.messages.map((m) =>
        m.image_urls?.length
          ? {
              role: m.role,
              content: [
                ...(m.content ? [{ type: "text", text: m.content }] : []),
                ...m.image_urls.map((url) => ({ type: "image", source: { type: "url", url } })),
              ],
            }
          : { role: m.role, content: m.content },
      ),
      max_tokens: input.maxTokens,
      ...(tools ? { tools } : {}),
      // `temperature` is deprecated on the Claude 4.x line (returns 400), so we
      // omit it for Anthropic and let the model use its default.
      stream: true,
    }),
  });
  if (!res.ok) {
    yield { type: "error", error: `Anthropic: ${await errorText(res)}` };
    return;
  }
  let stopReason: string | null = null;
  let outTokens: number | undefined;
  let inTokens: number | undefined;
  // Track server_tool_use blocks so we can surface the search query as a trace.
  const toolBlocks = new Map<number, { name: string; json: string }>();
  for await (const ev of iterateSSE(res)) {
    const t = ev.type as string;
    if (t === "message_start") {
      const usage = (ev.message as { usage?: { input_tokens?: number } })?.usage;
      inTokens = usage?.input_tokens;
    } else if (t === "content_block_start") {
      const idx = ev.index as number;
      const block = ev.content_block as
        | { type?: string; name?: string; content?: { url?: string; title?: string }[] }
        | undefined;
      if (block?.type === "server_tool_use" && block.name) {
        toolBlocks.set(idx, { name: block.name, json: "" });
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
        yield { type: "delta", text: delta.text };
      } else if (delta?.type === "citations_delta" && delta.citation?.url) {
        yield { type: "sources", sources: [{ url: delta.citation.url, title: delta.citation.title }] };
      } else if (delta?.type === "input_json_delta" && toolBlocks.has(idx)) {
        toolBlocks.get(idx)!.json += delta.partial_json ?? "";
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
      if (usage?.output_tokens != null) outTokens = usage.output_tokens;
    } else if (t === "error") {
      const e = ev.error as { message?: string } | undefined;
      yield { type: "error", error: `Anthropic: ${e?.message || "stream error"}` };
      return;
    }
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
  const messages = [
    ...(input.system ? [{ role: "system", content: input.system }] : []),
    ...input.messages.map((m) =>
      m.image_urls?.length
        ? {
            role: m.role,
            content: [
              ...(m.content ? [{ type: "text", text: m.content }] : []),
              ...m.image_urls.map((url) => ({ type: "image_url", image_url: { url } })),
            ],
          }
        : { role: m.role, content: m.content },
    ),
  ];
  const body: Record<string, unknown> = {
    model: input.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (isReasoning) {
    body.max_completion_tokens = input.maxTokens;
  } else {
    body.max_tokens = input.maxTokens;
    if (input.temperature != null) body.temperature = input.temperature;
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    yield { type: "error", error: `OpenAI: ${await errorText(res)}` };
    return;
  }
  let stopReason: string | null = null;
  let usage: { input?: number; output?: number } | undefined;
  for await (const chunk of iterateSSE(res)) {
    const choices = chunk.choices as
      | { delta?: { content?: string }; finish_reason?: string | null }[]
      | undefined;
    const choice = choices?.[0];
    if (choice?.delta?.content) yield { type: "delta", text: choice.delta.content };
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (u) usage = { input: u.prompt_tokens, output: u.completion_tokens };
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
  const tools = geminiTools(cap);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    input.model,
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: geminiContents(input),
      ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
      ...(tools ? { tools } : {}),
      generationConfig: {
        maxOutputTokens: input.maxTokens,
        ...(input.temperature != null ? { temperature: input.temperature } : {}),
      },
    }),
  });
  if (!res.ok) {
    yield { type: "error", error: `Gemini: ${await errorText(res)}` };
    return;
  }
  let usage: { input?: number; output?: number } | undefined;
  let stopReason: string | null = null;
  const seenSources = new Set<string>();
  const seenQueries = new Set<string>();
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
        if (p.text) yield { type: "delta", text: p.text };
        const code = geminiCodePartText(p);
        if (code) yield { type: "delta", text: code };
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
    if (meta) usage = { input: meta.promptTokenCount, output: meta.candidatesTokenCount };
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
