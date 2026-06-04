import { readSSE } from "./sse";
import type { ContextDocument } from "./tree";
import type { ApiKeys, Capability, Provider, Route, ServerConfig, Source, StreamEvent } from "./types";

export interface ChatRequest {
  route: Route;
  provider: Provider;
  model: string;
  system: string;
  messages: {
    role: "user" | "assistant";
    content: string;
    image_urls?: string[];
    documents?: ContextDocument[];
  }[];
  maxTokens: number;
  temperature?: number;
  /** Gemini thinking budget passthrough (0 off, -1 dynamic, >0 cap); omit for the
   * backend's per-model default. Forwarded to interpret for Gemini turns. */
  thinkingBudget?: number;
  /** Provider-native capability for this turn (defaults to plain chat). */
  capability?: Capability;
  keys: ApiKeys;
}

export async function getServerConfig(): Promise<ServerConfig> {
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) throw new Error();
    return (await res.json()) as ServerConfig;
  } catch {
    return { interpret: false, anthropic: false, openai: false, gemini: false };
  }
}

export interface StreamHandlers {
  onStart?: (ev: Extract<StreamEvent, { type: "start" }>) => void;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onTrace?: (text: string) => void;
  onStatus?: (text: string) => void;
  onImage?: (image: { b64?: string; url?: string; mime?: string }) => void;
  onSources?: (sources: Source[]) => void;
  onDone?: (ev: Extract<StreamEvent, { type: "done" }>) => void;
  onError?: (message: string) => void;
}

/** POST to the unified proxy and dispatch parsed events to handlers. */
export async function streamChat(
  req: ChatRequest,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) {
    if (res.status === 429) {
      let info: { error?: string } = {};
      try {
        info = (await res.json()) as typeof info;
      } catch {
        /* non-JSON body */
      }
      handlers.onError?.(info.error || "Too many requests. Please slow down.");
      return;
    }
    const text = await res.text().catch(() => "");
    handlers.onError?.(text || `Request failed (${res.status})`);
    return;
  }
  await readSSE(
    res,
    (ev) => {
      switch (ev.type) {
        case "start":
          handlers.onStart?.(ev);
          break;
        case "delta":
          handlers.onDelta?.(ev.text);
          break;
        case "reasoning":
          handlers.onReasoning?.(ev.text);
          break;
        case "trace":
          handlers.onTrace?.(ev.text);
          break;
        case "status":
          handlers.onStatus?.(ev.text);
          break;
        case "image":
          handlers.onImage?.({ b64: ev.b64, url: ev.url, mime: ev.mime });
          break;
        case "sources":
          handlers.onSources?.(ev.sources);
          break;
        case "done":
          handlers.onDone?.(ev);
          break;
        case "error":
          handlers.onError?.(ev.error);
          break;
      }
    },
    signal,
  );
}

/** Run a request to completion and return the concatenated text (used for compaction). */
export async function collectChat(req: ChatRequest, signal?: AbortSignal): Promise<string> {
  let out = "";
  let error = "";
  await streamChat(
    req,
    {
      onDelta: (t) => {
        out += t;
      },
      onError: (e) => {
        error = e;
      },
    },
    signal,
  );
  if (error && !out) throw new Error(error);
  return out;
}
