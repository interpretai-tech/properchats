/**
 * Core domain types for ProperChat.
 *
 * The conversation model is a tree: a `Chat` owns a tree of `ConvNode`s. The root node is the main conversation;
 * Slack-style threads are child nodes anchored to a specific message in their
 * parent. Within a node, `ModelSegment`s tag contiguous index ranges with the
 * provider/model that produced them, and `Compaction`s are the "compacted nodes":
 * a summary standing in for `messages[0..atIndex)`. Building the LLM context walks
 * from the leaf up the tree, stopping at the closest compaction on the path.
 */

export type Provider = "anthropic" | "openai" | "gemini";

/** How a turn is dispatched: through the interpret backend, or directly to the provider with a BYO key. */
export type Route = "interpret" | "direct";

/**
 * A provider-native "agent" capability beyond plain chat. These map to the
 * server-side tools each provider exposes (web search, image generation, deep
 * research, code interpreter), so ProperChat reaches the same functionality as
 * ChatGPT / Claude / Gemini do natively. See `capabilities.ts` for the matrix.
 */
export type Capability = "chat" | "web_search" | "image" | "deep_research" | "code";

/** A web/source citation surfaced by a search or research capability. */
export interface Source {
  url: string;
  title?: string;
}

/**
 * A whitelisted UI-only tool payload streamed to the chat client as a
 * `tool_ui` event. v1 supports audio only: `dataUrl` is a validated
 * `data:audio/(mpeg|wav|ogg);base64,…` URL (see `sanitizeToolUiPayload` in
 * `server/providers.ts` — anything else is dropped server-side, never sent).
 */
export interface ToolUiPayload {
  kind: "audio";
  dataUrl: string;
}

/** Input modality of an attachment; also used to restrict which models can read it. */
export type Modality = "text" | "image" | "audio" | "video" | "pdf";

/** A user-attached media file: a content-addressed reference + descriptor (never bytes). */
export interface MediaAttachment {
  /** s3://... once stored in the IAI -data- bucket, or a data: URL fallback. */
  uri: string;
  modality: Modality;
  mime: string;
  size: number;
  sha256: string;
}

export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: Role;
  content: string;
  /** Catalog model id used for this turn (assistant turns only). */
  modelId?: string;
  provider?: Provider;
  route?: Route;
  /** Capability used for this turn (assistant turns). Defaults to plain chat. */
  capability?: Capability;
  /** Friendly model/agent label for the tag, when no catalog entry fits (e.g. deep-research models). */
  modelName?: string;
  /** Images produced by an image capability, as data URLs or remote URLs. */
  images?: string[];
  /** Web citations gathered by a search/research capability. */
  sources?: Source[];
  /** The model's streamed reasoning/thinking summary (deep research, reasoning models). */
  reasoning?: string;
  /** Discrete tool activity steps, e.g. "Searched the web for …", "Ran code". */
  activity?: string[];
  /**
   * UI-only payloads produced by community tool calls this turn (e.g. a TTS
   * audio clip), delivered via `tool_ui` stream events. `tool`/`fn` are
   * registry-resolved ids, never model prose. Inline `data:` payloads are
   * stripped at persist time (same localStorage-quota rule as `images`).
   */
  toolUi?: { tool: string; fn: string; payload: ToolUiPayload }[];
  /** User-attached input media (image/video/audio/pdf) on a user turn. */
  attachments?: MediaAttachment[];
  /** Set on an assistant turn that failed; holds the error text. */
  error?: string;
  /**
   * Set on an image turn blocked because the selected model can't generate
   * images (e.g. Claude). Carries the capability and the image-capable
   * providers to offer, so the UI can let the user pick a fallback explicitly
   * instead of silently rerouting (which produced cryptic backend errors).
   */
  capabilityFallback?: { capability: Capability; providers: Provider[] };
  createdAt: string;
}

/** A contiguous run of messages sharing one provider/model, by index range. */
export interface ModelSegment {
  /** Inclusive index into `node.messages` where this model started producing. */
  startIndex: number;
  modelId: string;
  provider: Provider;
}

/** A "compacted node": `summary` represents `messages[0..atIndex)`. */
export interface Compaction {
  id: string;
  atIndex: number;
  summary: string;
  modelId: string;
  createdAt: string;
}

export interface ConvNode {
  id: string;
  chatId: string;
  parentId: string | null;
  /** 0 = main conversation, 1 = thread, 2 = sub-thread. Capped by MAX_THREAD_BRANCHING. */
  depth: number;
  /** Id of the parent message this thread branched from (null for the root). */
  anchorMessageId: string | null;
  /** Short preview of the anchored message, for the thread header. */
  anchorPreview: string | null;
  /** Optional excerpt the user highlighted when branching; focuses the thread. */
  highlight?: string | null;
  /** Rough auto-summary used in the thread-tree popover and headers. */
  title: string;
  messages: Message[];
  segments: ModelSegment[];
  compactions: Compaction[];
  childIds: string[];
  /** Model used for the next turn in this node. */
  currentModelId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Chat {
  id: string;
  title: string;
  rootNodeId: string;
  createdAt: string;
  updatedAt: string;
}

/** The unified streaming protocol every backend adapter emits (see /api/chat). */
export type StreamEvent =
  | { type: "start"; provider: Provider; route: Route; model: string }
  | { type: "delta"; text: string }
  /** Incremental reasoning/thinking summary text (deep research, reasoning models). */
  | { type: "reasoning"; text: string }
  /** A discrete tool-activity step to record (e.g. a web-search query, "Ran code"). */
  | { type: "trace"; text: string }
  /** A transient progress note (e.g. "Searching the web…"); not persisted into the message. */
  | { type: "status"; text: string }
  /** An image produced by an image capability (base64 or URL). */
  | { type: "image"; b64?: string; url?: string; mime?: string }
  /** A whitelisted UI-only payload from a community tool call (audio in v1). */
  | { type: "tool_ui"; tool: string; fn: string; payload: ToolUiPayload }
  /** Citations gathered during this turn. */
  | { type: "sources"; sources: Source[] }
  | { type: "done"; usage?: { input?: number; output?: number }; stopReason?: string | null }
  | { type: "error"; error: string };

/** Per-user keys held client-side (localStorage) and sent to our own proxy per request. */
export interface ApiKeys {
  interpret?: string;
  anthropic?: string;
  openai?: string;
  gemini?: string;
}

/** Which providers have a usable server-side key (booleans only; never the keys). */
export interface ServerConfig {
  interpret: boolean;
  anthropic: boolean;
  openai: boolean;
  gemini: boolean;
}
