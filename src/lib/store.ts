"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { collectChat, getServerConfig, streamChat } from "./api";
import {
  chooseRoute,
  DEFAULT_MODEL_ID,
  getModel,
  MODELS,
  modelConcreteId,
  modelLabel,
  PROVIDERS,
} from "./models";
import {
  type Availability,
  IMAGE_PROVIDERS,
  providerAvailability,
  resolveCapability,
} from "./capabilities";
import { providerSupportsModality } from "./modalities";
import { DEFAULT_OUTPUT_TOKENS, STORE_NAME, THEME_KEY, THREAD_WIDTH_DEFAULT } from "./constants";
import { contextTokens, needsCompaction } from "./context";
import { buildContext, canBranch, deriveTitle, descendantIds } from "./tree";
import type {
  ApiKeys,
  Capability,
  Chat,
  Compaction,
  ConvNode,
  MediaAttachment,
  Message,
  ModelSegment,
  Provider,
  Route,
  ServerConfig,
  Source,
} from "./types";

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
const nowISO = () => new Date().toISOString();

/**
 * A normalized one-line preview of markdown text. Exported so the renderer can
 * match a paragraph back to the thread that was branched from it (both sides
 * normalize identically) and show the thread marker inline at that spot.
 */
export function snippet(text: string, n = 90): string {
  const t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
}

/**
 * Whether a thread's stored `highlight` excerpt came from this block of text.
 * Used to place the thread marker inline at the paragraph it was branched from:
 * matches a whole-paragraph branch exactly, or a sub-paragraph text selection by
 * containment (the highlight is a normalized, possibly-truncated snippet).
 */
export function highlightMatchesText(text: string, highlight: string): boolean {
  if (!highlight) return false;
  if (snippet(text, 240) === highlight) return true;
  const core = highlight.replace(/…$/u, "").trim();
  return core.length >= 8 && snippet(text, 100_000).includes(core);
}

/** Append new citations to a message's source list, de-duplicating by URL. */
function mergeSources(existing: Source[] | undefined, incoming: Source[]): Source[] {
  const out = existing ? existing.slice() : [];
  const seen = new Set(out.map((s) => s.url));
  for (const s of incoming) {
    if (s.url && !seen.has(s.url)) {
      seen.add(s.url);
      out.push(s);
    }
  }
  return out;
}

/**
 * Drop inline base64 (`data:`) images before persisting so a couple of generated
 * images can't exceed the localStorage quota and silently break persistence of
 * the entire chat tree. Remote (http) image URLs are small and kept.
 */
function stripInlineImages(nodes: Record<string, ConvNode>): Record<string, ConvNode> {
  let changed = false;
  const out: Record<string, ConvNode> = {};
  for (const [id, node] of Object.entries(nodes)) {
    let nodeChanged = false;
    const messages = node.messages.map((m) => {
      if (!m.images?.some((src) => src.startsWith("data:"))) return m;
      nodeChanged = true;
      const kept = m.images.filter((src) => !src.startsWith("data:"));
      return kept.length ? { ...m, images: kept } : { ...m, images: undefined };
    });
    if (nodeChanged) {
      changed = true;
      out[id] = { ...node, messages };
    } else {
      out[id] = node;
    }
  }
  return changed ? out : nodes;
}

/** Everything needed to dispatch one turn: the concrete request fields + display tag. */
interface TurnPlan {
  provider: Provider;
  route: Route;
  /** Concrete model id to send to the proxy. */
  model: string;
  /** Friendly label for the message tag. */
  modelName: string;
  capability: Capability;
}

/**
 * Immediate, capability-specific status shown the instant a tool turn starts —
 * before the provider's first event arrives (which can take seconds for image
 * generation / research) — so the user always gets feedback like "Generating
 * image…" instead of generic dots. The provider's own status events override it.
 */
const CAPABILITY_START_STATUS: Partial<Record<Capability, string>> = {
  web_search: "Searching the web…",
  image: "Generating image…",
  deep_research: "Researching…",
  code: "Running code…",
};

/**
 * Plan a turn for a node's current model and a chosen capability. Plain chat
 * uses the catalog model + normal interpret/direct routing; a capability
 * resolves to the provider that natively serves it (always a direct call).
 */
function planTurn(
  modelId: string,
  capability: Capability,
  keys: ApiKeys,
  cfg: ServerConfig | null,
  hasDocuments: boolean,
): TurnPlan {
  if (capability && capability !== "chat") {
    const resolved = resolveCapability(capability, modelId, providerAvailability(keys, cfg));
    if (resolved) {
      return {
        provider: resolved.provider,
        route: resolved.route,
        model: resolved.model,
        modelName: resolved.modelName,
        capability,
      };
    }
  }
  const model = getModel(modelId);
  // A PDF turn must go DIRECT: the interpret route's ChatTurn carries only
  // text + image_urls and would silently drop the document. Force direct so
  // the provider adapter can emit the native document block.
  const route = hasDocuments ? "direct" : chooseRoute(model.provider, keys, cfg);
  return {
    provider: model.provider,
    route,
    model: modelConcreteId(model, route),
    modelName: modelLabel(model, route),
    capability: "chat",
  };
}

/** Short verb phrase per capability for the "<provider> can't <phrase>" block. */
const CANT_DO_PHRASE: Partial<Record<Capability, string>> = {
  image: "generate images",
};

/**
 * Guard against silently rerouting an image turn to a provider the user didn't
 * pick. Only image-capable providers can serve it (see IMAGE_PROVIDERS); on a
 * model that can't (Claude), the old behavior quietly resolved to another
 * provider and the user got a cryptic error. Returns a block descriptor — a
 * helpful message + the image-capable providers to offer — or null when the turn
 * can proceed (chat, a tool capability, or an already image-capable model).
 *
 * Capabilities run as direct provider calls, so only providers with a usable key
 * (BYO or server-side) are offered as fallbacks.
 */
function capabilityBlock(
  modelId: string,
  capability: Capability,
  avail: Availability,
): { message: string; providers: Provider[] } | null {
  if (capability !== "image") return null; // tool capabilities reroute fine
  const provider = getModel(modelId).provider;
  if (IMAGE_PROVIDERS.includes(provider)) return null;
  const label = PROVIDERS[provider].label;
  const phrase = CANT_DO_PHRASE[capability] ?? "do that";
  const providers = IMAGE_PROVIDERS.filter((p) => avail[p]);
  if (providers.length) {
    return { message: `${label} can't ${phrase}. Pick a model that can:`, providers };
  }
  const names = IMAGE_PROVIDERS.map((p) => PROVIDERS[p].company).join(" or ");
  return {
    message: `${label} can't ${phrase}. Add an API key for ${names} in Settings to ${phrase}.`,
    providers: [],
  };
}

/** A representative catalog model for a provider (its large tier), used to plan
 *  a capability turn on a provider the user explicitly picked. */
function representativeModelId(provider: Provider): string {
  const m =
    MODELS.find((x) => x.provider === provider && x.size === "large") ??
    MODELS.find((x) => x.provider === provider);
  return (m ?? MODELS[0]).id;
}

/** Plan a capability turn on a specific provider (the picked image fallback). */
function capabilityPlanForProvider(
  capability: Capability,
  provider: Provider,
  keys: ApiKeys,
  cfg: ServerConfig | null,
): TurnPlan | null {
  const resolved = resolveCapability(
    capability,
    representativeModelId(provider),
    providerAvailability(keys, cfg),
  );
  if (!resolved) return null;
  return {
    provider: resolved.provider,
    route: resolved.route,
    model: resolved.model,
    modelName: resolved.modelName,
    capability,
  };
}

type Theme = "light" | "dark";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const t = localStorage.getItem(THEME_KEY);
  if (t === "light" || t === "dark") return t;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

export interface Settings {
  keys: ApiKeys;
  defaultModelId: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  /** Auto-summarize older history when nearing the model's context window. */
  autoCompact: boolean;
  /** Reveal power-user controls (manual compaction, internals). Off by default. */
  nerdTools: boolean;
  /** Line-height for message text (drives the --prose-leading CSS variable). */
  lineSpacing: number;
  /** Desktop thread-panel width in px, set by dragging its left edge. */
  threadWidth: number;
}

/** Bounds for the line-spacing control, also used to clamp persisted values. */
export const LINE_SPACING_MIN = 1.2;
export const LINE_SPACING_MAX = 2.0;

const DEFAULT_SETTINGS: Settings = {
  keys: {},
  defaultModelId: DEFAULT_MODEL_ID,
  systemPrompt: "",
  temperature: 0.7,
  maxTokens: DEFAULT_OUTPUT_TOKENS,
  autoCompact: true,
  nerdTools: false,
  lineSpacing: 1.5,
  threadWidth: THREAD_WIDTH_DEFAULT,
};

interface StoreState {
  // ---- persisted ----
  chats: Record<string, Chat>;
  nodes: Record<string, ConvNode>;
  chatOrder: string[];
  activeChatId: string | null;
  settings: Settings;

  // ---- transient ----
  theme: Theme;
  hydrated: boolean;
  serverConfig: ServerConfig | null;
  openThreadNodeId: string | null;
  /** nodeId -> assistant messageId currently streaming. */
  streamingNodeIds: Record<string, string>;
  /** nodeId -> transient progress note while a tool runs ("Searching the web…"). */
  streamingStatus: Record<string, string>;
  /** nodeId -> true while a compaction summary is being generated. */
  compacting: Record<string, boolean>;
  /** catalog modelId -> context window in tokens, detected via provider API. */
  modelWindows: Record<string, number>;

  // ---- actions ----
  bootstrap: () => Promise<void>;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  updateSettings: (partial: Partial<Settings>) => void;
  setKeys: (partial: Partial<ApiKeys>) => void;

  newChat: () => string;
  selectChat: (chatId: string) => void;
  deleteChat: (chatId: string) => void;
  renameChat: (chatId: string, title: string) => void;

  setNodeModel: (nodeId: string, modelId: string) => void;
  branchThread: (
    parentNodeId: string,
    anchorMessageId: string,
    highlight?: string,
  ) => string | null;
  openThread: (nodeId: string) => void;
  closeThread: () => void;

  sendMessage: (
    nodeId: string,
    text: string,
    capability?: Capability,
    attachments?: MediaAttachment[],
  ) => Promise<void>;
  stopStream: (nodeId: string) => void;
  regenerate: (nodeId: string) => Promise<void>;
  /** Re-run a capability turn on a specific provider the user picked (image fallback). */
  generateWithProvider: (
    nodeId: string,
    messageId: string,
    capability: Capability,
    provider: Provider,
  ) => Promise<void>;
  compact: (nodeId: string) => Promise<void>;
  /** Best-effort: ask each provider's API for a model's real context window. */
  detectModelWindow: (modelId: string) => Promise<void>;
}

// AbortControllers live outside the store (not serializable).
const controllers = new Map<string, AbortController>();

function makeRootNode(chatId: string, modelId: string): ConvNode {
  const now = nowISO();
  return {
    id: uid(),
    chatId,
    parentId: null,
    depth: 0,
    anchorMessageId: null,
    anchorPreview: null,
    title: "New chat",
    messages: [],
    segments: [],
    compactions: [],
    childIds: [],
    currentModelId: modelId,
    createdAt: now,
    updatedAt: now,
  };
}

export const useStore = create<StoreState>()(
  persist(
    (set, get) => {
      /** Replace one node immutably and bump its updatedAt. */
      const patchNode = (nodeId: string, fn: (n: ConvNode) => ConvNode) =>
        set((s) => {
          const n = s.nodes[nodeId];
          if (!n) return {};
          return { nodes: { ...s.nodes, [nodeId]: { ...fn(n), updatedAt: nowISO() } } };
        });

      /** Patch a single message within a node. */
      const patchMessage = (nodeId: string, messageId: string, fn: (m: Message) => Message) =>
        patchNode(nodeId, (n) => {
          const idx = n.messages.findIndex((m) => m.id === messageId);
          if (idx === -1) return n;
          const messages = n.messages.slice();
          messages[idx] = fn(messages[idx]);
          return { ...n, messages };
        });

      const setStatus = (nodeId: string, text: string | null) =>
        set((s) => {
          const next = { ...s.streamingStatus };
          if (text) next[nodeId] = text;
          else delete next[nodeId];
          return { streamingStatus: next };
        });

      /**
       * A thread the user opened but never chatted in: a non-root node with no
       * messages, no sub-threads, and no highlighted excerpt. The rule "a thread
       * persists iff the user put something in it" is enforced by pruning these
       * whenever we navigate away, so opening a thread and closing it without
       * sending (and without a captured excerpt) leaves no trace in the tree, the
       * thread list, or persisted storage.
       */
      const isEmptyThread = (n: ConvNode | undefined): boolean =>
        Boolean(n) &&
        n!.parentId !== null &&
        n!.messages.length === 0 &&
        n!.childIds.length === 0 &&
        // A thread branched from a highlighted excerpt carries that excerpt as
        // deliberate, visible content the user captured on purpose, so it is NOT
        // empty and persists even before the first reply.
        !n!.highlight;

      /** Drop one empty thread node and unlink it from its parent. No-op otherwise. */
      const discardIfEmptyThread = (nodeId: string | null | undefined) => {
        if (!nodeId) return;
        const n = get().nodes[nodeId];
        if (!isEmptyThread(n)) return;
        controllers.get(nodeId)?.abort();
        controllers.delete(nodeId);
        set((s) => {
          const nodes = { ...s.nodes };
          delete nodes[nodeId];
          const parentId = n!.parentId!;
          const parent = nodes[parentId];
          if (parent) {
            nodes[parentId] = { ...parent, childIds: parent.childIds.filter((id) => id !== nodeId) };
          }
          return { nodes };
        });
      };

      /** Sweep all empty threads at once (e.g. left over from a refresh-while-open). */
      const pruneEmptyThreads = () => {
        const dead = new Set(
          Object.values(get().nodes).filter(isEmptyThread).map((n) => n.id),
        );
        if (!dead.size) return;
        set((s) => {
          const nodes: Record<string, ConvNode> = {};
          for (const [id, n] of Object.entries(s.nodes)) {
            if (dead.has(id)) continue;
            nodes[id] = n.childIds.some((c) => dead.has(c))
              ? { ...n, childIds: n.childIds.filter((c) => !dead.has(c)) }
              : n;
          }
          return { nodes };
        });
      };

      const runStream = async (nodeId: string, assistantId: string, plan: TurnPlan) => {
        const state = get();
        const node = state.nodes[nodeId];
        if (!node) return;
        const built = buildContext(state.nodes, nodeId, state.settings.systemPrompt);
        const isCapability = plan.capability !== "chat";

        const controller = new AbortController();
        controllers.set(nodeId, controller);
        set((s) => ({ streamingNodeIds: { ...s.streamingNodeIds, [nodeId]: assistantId } }));

        // Show capability feedback immediately, before the first provider event.
        const startStatus = CAPABILITY_START_STATUS[plan.capability];
        if (startStatus) setStatus(nodeId, startStatus);

        // Buffer deltas/reasoning and flush at ~25fps so markdown re-renders stay
        // smooth even when tokens arrive faster than the browser can paint.
        let pending = "";
        let pendingReasoning = "";
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const flush = () => {
          flushTimer = null;
          if (!pending && !pendingReasoning) return;
          const add = pending;
          const addReasoning = pendingReasoning;
          pending = "";
          pendingReasoning = "";
          patchMessage(nodeId, assistantId, (m) => ({
            ...m,
            content: m.content + add,
            ...(addReasoning ? { reasoning: (m.reasoning ?? "") + addReasoning } : {}),
          }));
        };
        const scheduleFlush = () => {
          if (!flushTimer) flushTimer = setTimeout(flush, 40);
        };

        try {
          await streamChat(
            {
              route: plan.route,
              provider: plan.provider,
              model: plan.model,
              system: built.system,
              messages: built.messages,
              maxTokens: state.settings.maxTokens,
              // Tool/agent turns (image, deep research, reasoning) reject a custom
              // temperature; only send it for plain chat.
              temperature: isCapability ? undefined : state.settings.temperature,
              capability: plan.capability,
              keys: state.settings.keys,
            },
            {
              onStart: (ev) =>
                patchMessage(nodeId, assistantId, (m) => ({
                  ...m,
                  provider: ev.provider,
                  route: ev.route,
                })),
              onStatus: (text) => setStatus(nodeId, text),
              onDelta: (t) => {
                setStatus(nodeId, null);
                pending += t;
                scheduleFlush();
              },
              onReasoning: (t) => {
                pendingReasoning += t;
                scheduleFlush();
              },
              onTrace: (t) => {
                setStatus(nodeId, null);
                patchMessage(nodeId, assistantId, (m) => {
                  const activity = m.activity ?? [];
                  if (activity[activity.length - 1] === t) return m;
                  return { ...m, activity: [...activity, t] };
                });
              },
              onImage: (img) => {
                const src = img.url || (img.b64 ? `data:${img.mime || "image/png"};base64,${img.b64}` : "");
                if (!src) return;
                setStatus(nodeId, null);
                patchMessage(nodeId, assistantId, (m) => ({
                  ...m,
                  images: [...(m.images ?? []), src],
                }));
              },
              onSources: (sources) =>
                patchMessage(nodeId, assistantId, (m) => ({
                  ...m,
                  sources: mergeSources(m.sources, sources),
                })),
              onError: (e) => patchMessage(nodeId, assistantId, (m) => ({ ...m, error: e })),
            },
            controller.signal,
          );
        } catch (err) {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            const msg = err instanceof Error ? err.message : String(err);
            patchMessage(nodeId, assistantId, (m) => ({ ...m, error: msg }));
          }
        } finally {
          if (flushTimer) clearTimeout(flushTimer);
          flush();
          setStatus(nodeId, null);
          controllers.delete(nodeId);
          set((s) => {
            const next = { ...s.streamingNodeIds };
            delete next[nodeId];
            return { streamingNodeIds: next };
          });
          patchMessage(nodeId, assistantId, (m) => {
            const gotSomething =
              m.content.trim() ||
              m.error ||
              (m.images && m.images.length) ||
              (m.sources && m.sources.length) ||
              m.reasoning?.trim() ||
              (m.activity && m.activity.length);
            return gotSomething ? m : { ...m, error: "No response from model." };
          });
        }
      };

      /** The context window we'll use for a model: API-detected, else catalog. */
      const windowFor = (modelId: string): number =>
        get().modelWindows[modelId] ?? getModel(modelId).contextWindow;

      /**
       * Before a turn, if the assembled context is approaching the model's
       * window, summarize older history into a compaction so the conversation
       * keeps flowing. `compact` keeps the most recent user turn live.
       */
      const maybeAutoCompact = async (nodeId: string) => {
        const s = get();
        if (!s.settings.autoCompact || s.compacting[nodeId]) return;
        const node = s.nodes[nodeId];
        if (!node) return;
        const built = buildContext(s.nodes, nodeId, s.settings.systemPrompt);
        const used = contextTokens(built);
        if (!needsCompaction(used, windowFor(node.currentModelId), s.settings.maxTokens)) return;
        await get().compact(nodeId);
      };

      return {
        chats: {},
        nodes: {},
        chatOrder: [],
        activeChatId: null,
        settings: DEFAULT_SETTINGS,

        theme: "light",
        hydrated: false,
        serverConfig: null,
        openThreadNodeId: null,
        streamingNodeIds: {},
        streamingStatus: {},
        compacting: {},
        modelWindows: {},

        async bootstrap() {
          if (typeof window === "undefined") return;
          const theme = getInitialTheme();
          applyTheme(theme);
          set({ theme });

          // Wait for persist rehydration before touching chats - otherwise the
          // "ensure a chat exists" logic below would run against empty defaults
          // and clobber the saved conversation tree on reload.
          if (!useStore.persist.hasHydrated()) {
            await new Promise<void>((resolve) => {
              let done = false;
              const finish = () => {
                if (done) return;
                done = true;
                resolve();
              };
              const unsub = useStore.persist.onFinishHydration(finish);
              if (useStore.persist.hasHydrated()) finish();
              // Safety net so we never hang if hydration never fires.
              setTimeout(finish, 2000);
              void unsub;
            });
          }

          // Drop dangling active chat; ensure one chat exists.
          const { activeChatId, chats, chatOrder } = get();
          if (activeChatId && !chats[activeChatId]) set({ activeChatId: null });
          if (chatOrder.length === 0) {
            get().newChat();
          } else if (!get().activeChatId) {
            set({ activeChatId: chatOrder[0] });
          }
          // Clean up threads opened-but-never-used in a prior session (or left by a
          // refresh while a fresh thread was open). openThreadNodeId is transient
          // (not persisted), so nothing is mid-edit at this point.
          pruneEmptyThreads();
          set({ hydrated: true });

          const cfg = await getServerConfig();
          set({ serverConfig: cfg });

          // Best-effort: learn the real context window for the default model.
          void get().detectModelWindow(get().settings.defaultModelId);
        },

        setTheme(theme) {
          applyTheme(theme);
          set({ theme });
        },
        toggleTheme() {
          const theme: Theme = get().theme === "dark" ? "light" : "dark";
          applyTheme(theme);
          set({ theme });
        },

        updateSettings(partial) {
          set((s) => ({ settings: { ...s.settings, ...partial } }));
        },
        setKeys(partial) {
          set((s) => ({ settings: { ...s.settings, keys: { ...s.settings.keys, ...partial } } }));
        },

        newChat() {
          const prevOpen = get().openThreadNodeId;
          const chatId = uid();
          const root = makeRootNode(chatId, get().settings.defaultModelId);
          const now = nowISO();
          const chat: Chat = {
            id: chatId,
            title: "New chat",
            rootNodeId: root.id,
            createdAt: now,
            updatedAt: now,
          };
          set((s) => ({
            chats: { ...s.chats, [chatId]: chat },
            nodes: { ...s.nodes, [root.id]: root },
            chatOrder: [chatId, ...s.chatOrder],
            activeChatId: chatId,
            openThreadNodeId: null,
          }));
          discardIfEmptyThread(prevOpen);
          return chatId;
        },

        selectChat(chatId) {
          if (!get().chats[chatId]) return;
          const prevOpen = get().openThreadNodeId;
          set({ activeChatId: chatId, openThreadNodeId: null });
          discardIfEmptyThread(prevOpen);
        },

        deleteChat(chatId) {
          const chat = get().chats[chatId];
          if (!chat) return;
          // Abort any in-flight streams in this chat's nodes.
          const toRemove = [chat.rootNodeId, ...descendantIds(get().nodes, chat.rootNodeId)];
          toRemove.forEach((id) => controllers.get(id)?.abort());
          set((s) => {
            const nodes = { ...s.nodes };
            toRemove.forEach((id) => delete nodes[id]);
            const chats = { ...s.chats };
            delete chats[chatId];
            const chatOrder = s.chatOrder.filter((id) => id !== chatId);
            const activeChatId =
              s.activeChatId === chatId ? chatOrder[0] ?? null : s.activeChatId;
            return { nodes, chats, chatOrder, activeChatId, openThreadNodeId: null };
          });
          if (get().chatOrder.length === 0) get().newChat();
        },

        renameChat(chatId, title) {
          set((s) => {
            const chat = s.chats[chatId];
            if (!chat) return {};
            return {
              chats: { ...s.chats, [chatId]: { ...chat, title: title.trim() || chat.title } },
            };
          });
        },

        setNodeModel(nodeId, modelId) {
          patchNode(nodeId, (n) => ({ ...n, currentModelId: modelId }));
          void get().detectModelWindow(modelId);
        },

        branchThread(parentNodeId, anchorMessageId, highlight) {
          const parent = get().nodes[parentNodeId];
          if (!canBranch(parent)) return null;
          const prevOpen = get().openThreadNodeId;
          const anchor =
            parent!.messages.find((m) => m.id === anchorMessageId) ??
            parent!.messages[parent!.messages.length - 1];
          const now = nowISO();
          const trimmedHighlight = highlight?.trim() || null;
          const child: ConvNode = {
            id: uid(),
            chatId: parent!.chatId,
            parentId: parent!.id,
            depth: parent!.depth + 1,
            anchorMessageId: anchor?.id ?? null,
            anchorPreview: anchor ? snippet(anchor.content) : null,
            highlight: trimmedHighlight ? snippet(trimmedHighlight, 240) : null,
            title: trimmedHighlight ? snippet(trimmedHighlight, 40) : "Thread",
            messages: [],
            segments: [],
            compactions: [],
            childIds: [],
            currentModelId: parent!.currentModelId,
            createdAt: now,
            updatedAt: now,
          };
          set((s) => ({
            nodes: {
              ...s.nodes,
              [child.id]: child,
              [parent!.id]: {
                ...s.nodes[parent!.id],
                childIds: [...s.nodes[parent!.id].childIds, child.id],
              },
            },
            openThreadNodeId: child.id,
          }));
          // Replacing an unused open thread with a fresh branch discards the old one.
          if (prevOpen && prevOpen !== child.id) discardIfEmptyThread(prevOpen);
          return child.id;
        },

        openThread(nodeId) {
          if (!get().nodes[nodeId]) return;
          const prev = get().openThreadNodeId;
          set({ openThreadNodeId: nodeId });
          // Switching away from a thread we never used (e.g. back out of an empty
          // sub-thread) discards it.
          if (prev && prev !== nodeId) discardIfEmptyThread(prev);
        },
        closeThread() {
          const open = get().openThreadNodeId;
          set({ openThreadNodeId: null });
          discardIfEmptyThread(open);
        },

        async sendMessage(nodeId, text, capability = "chat", attachments) {
          const trimmed = text.trim();
          const media = attachments && attachments.length ? attachments : undefined;
          if (!trimmed && !media) return;
          const node = get().nodes[nodeId];
          if (!node) return;
          if (get().streamingNodeIds[nodeId]) get().stopStream(nodeId);

          const modelId = node.currentModelId;
          const { keys } = get().settings;
          const cfg = get().serverConfig;
          // Don't silently reroute an image turn to a provider the user didn't
          // pick (e.g. Claude). Block with a helpful error + offer the
          // image-capable providers the user can run directly.
          const capBlock = capabilityBlock(modelId, capability, providerAvailability(keys, cfg));
          // A PDF attachment forces a direct provider call (the interpret route
          // can't carry documents). Plan accordingly so the right provider/route
          // is chosen before we check whether that provider can read PDFs.
          const hasPdf = Boolean(media?.some((a) => a.modality === "pdf"));
          const plan = capBlock
            ? planTurn(modelId, "chat", keys, cfg, false)
            : planTurn(modelId, capability, keys, cfg, hasPdf);
          // Fail loud when a PDF is attached but the resolved provider can't read
          // one. Record the reply as an error and skip the stream.
          const pdfBlock =
            !capBlock && hasPdf && !providerSupportsModality(plan.provider, "pdf")
              ? `This model from ${PROVIDERS[plan.provider].company} doesn't support PDF. Switch to a model that reads PDFs.`
              : undefined;
          const now = nowISO();
          const userMsg: Message = {
            id: uid(),
            role: "user",
            content: trimmed,
            ...(media ? { attachments: media } : {}),
            createdAt: now,
          };
          const assistantMsg: Message = {
            id: uid(),
            role: "assistant",
            content: "",
            modelId,
            provider: plan.provider,
            route: plan.route,
            capability: capBlock ? capability : plan.capability,
            modelName: plan.modelName,
            ...(capBlock ? { error: capBlock.message } : pdfBlock ? { error: pdfBlock } : {}),
            ...(capBlock && capBlock.providers.length
              ? { capabilityFallback: { capability, providers: capBlock.providers } }
              : {}),
            createdAt: now,
          };

          set((s) => {
            const n = s.nodes[nodeId];
            const lastSeg = n.segments[n.segments.length - 1];
            const newSeg: ModelSegment = {
              startIndex: n.messages.length,
              modelId,
              provider: plan.provider,
            };
            const segments =
              !lastSeg || lastSeg.modelId !== modelId ? [...n.segments, newSeg] : n.segments;
            const isFresh = n.messages.length === 0;
            const title = isFresh && n.parentId !== null ? snippet(trimmed, 40) : n.title;
            const updatedNode: ConvNode = {
              ...n,
              messages: [...n.messages, userMsg, assistantMsg],
              segments,
              title: n.title === "New chat" || n.title === "Thread" ? deriveTitle(trimmed) : title,
              updatedAt: now,
            };
            const chat = s.chats[n.chatId];
            const chats =
              n.parentId === null && chat && chat.title === "New chat"
                ? { ...s.chats, [chat.id]: { ...chat, title: deriveTitle(trimmed), updatedAt: now } }
                : s.chats;
            // bump chat to top of sidebar
            const chatOrder = [
              n.chatId,
              ...s.chatOrder.filter((id) => id !== n.chatId),
            ];
            return { nodes: { ...s.nodes, [nodeId]: updatedNode }, chats, chatOrder };
          });

          // A blocked image turn is recorded as an errored reply with fallback
          // picks; nothing to stream until the user chooses a provider. A PDF
          // turn whose provider can't read PDFs is likewise an errored reply.
          if (capBlock || pdfBlock) return;

          // Auto-compact older history if we're nearing the model's window.
          await maybeAutoCompact(nodeId);
          await runStream(nodeId, assistantMsg.id, plan);
        },

        stopStream(nodeId) {
          controllers.get(nodeId)?.abort();
          controllers.delete(nodeId);
          set((s) => {
            const next = { ...s.streamingNodeIds };
            delete next[nodeId];
            const status = { ...s.streamingStatus };
            delete status[nodeId];
            return { streamingNodeIds: next, streamingStatus: status };
          });
        },

        async regenerate(nodeId) {
          const node = get().nodes[nodeId];
          if (!node || get().streamingNodeIds[nodeId]) return;
          // Find the last assistant message and reset it for a fresh stream.
          const lastIdx = node.messages.length - 1;
          if (lastIdx < 0 || node.messages[lastIdx].role !== "assistant") return;
          const assistant = node.messages[lastIdx];
          // Re-run with the same capability the turn originally used.
          const capability = assistant.capability ?? "chat";
          const { keys } = get().settings;
          const cfg = get().serverConfig;
          // If the turn already ran on an image-capable provider (a fallback the
          // user picked), redo it there. Otherwise apply the same image guard as
          // sendMessage so a regenerate can't silently reroute either.
          const serving =
            capability === "image" &&
            assistant.provider &&
            IMAGE_PROVIDERS.includes(assistant.provider)
              ? assistant.provider
              : undefined;
          const capBlock = serving
            ? null
            : capabilityBlock(node.currentModelId, capability, providerAvailability(keys, cfg));
          // A PDF anywhere in this node's history forces a direct call on regen
          // too (mirrors sendMessage); the document travels in the rebuilt context.
          const hasPdf = node.messages.some((m) =>
            m.attachments?.some((a) => a.modality === "pdf"),
          );
          const plan: TurnPlan =
            (serving ? capabilityPlanForProvider(capability, serving, keys, cfg) : null) ??
            (capBlock
              ? planTurn(node.currentModelId, "chat", keys, cfg, false)
              : planTurn(node.currentModelId, capability, keys, cfg, hasPdf));
          const pdfBlock =
            !serving && !capBlock && hasPdf && !providerSupportsModality(plan.provider, "pdf")
              ? `This model from ${PROVIDERS[plan.provider].company} doesn't support PDF. Switch to a model that reads PDFs.`
              : undefined;
          patchNode(nodeId, (n) => {
            const messages = n.messages.slice();
            messages[lastIdx] = {
              ...assistant,
              content: "",
              images: undefined,
              sources: undefined,
              reasoning: undefined,
              activity: undefined,
              error: capBlock?.message ?? pdfBlock,
              capabilityFallback:
                capBlock && capBlock.providers.length
                  ? { capability, providers: capBlock.providers }
                  : undefined,
              modelId: n.currentModelId,
              provider: plan.provider,
              route: plan.route,
              capability: capBlock ? capability : plan.capability,
              modelName: plan.modelName,
              createdAt: nowISO(),
            };
            return { ...n, messages };
          });
          if (capBlock || pdfBlock) return;
          await maybeAutoCompact(nodeId);
          await runStream(nodeId, assistant.id, plan);
        },

        async generateWithProvider(nodeId, messageId, capability, provider) {
          const node = get().nodes[nodeId];
          if (!node || get().streamingNodeIds[nodeId]) return;
          if (!node.messages.some((m) => m.id === messageId)) return;
          const { keys } = get().settings;
          const cfg = get().serverConfig;
          const plan = capabilityPlanForProvider(capability, provider, keys, cfg);
          if (!plan) return;
          // Reset the blocked message (clear the error + fallback chips) and
          // stream the chosen provider's result into it.
          patchMessage(nodeId, messageId, (m) => ({
            ...m,
            content: "",
            images: undefined,
            sources: undefined,
            reasoning: undefined,
            activity: undefined,
            error: undefined,
            capabilityFallback: undefined,
            provider: plan.provider,
            route: plan.route,
            capability: plan.capability,
            modelName: plan.modelName,
            createdAt: nowISO(),
          }));
          await maybeAutoCompact(nodeId);
          await runStream(nodeId, messageId, plan);
        },

        async compact(nodeId) {
          const state = get();
          const node = state.nodes[nodeId];
          if (!node || node.messages.length === 0 || state.compacting[nodeId]) return;

          // Compact everything *before* the most recent user turn, keeping that
          // turn (and its reply) live. This is what lets the conversation keep
          // going and the last reply be regenerated after a compaction: the
          // prompting user message is never swallowed by the summary.
          const lastUserIdx = (() => {
            for (let j = node.messages.length - 1; j >= 0; j--) {
              if (node.messages[j].role === "user") return j;
            }
            return -1;
          })();
          if (lastUserIdx < 1) return; // not enough prior history to summarize
          // Already compacted up to (or past) this boundary: nothing new to do.
          if (node.compactions.some((c) => c.atIndex >= lastUserIdx)) return;

          const model = getModel(node.currentModelId);
          const route = chooseRoute(model.provider, state.settings.keys, state.serverConfig);
          const built = buildContext(state.nodes, nodeId, "");
          if (!built.messages.length) return;
          const priorSummary = built.system.trim();

          set((s) => ({ compacting: { ...s.compacting, [nodeId]: true } }));
          try {
            const summary = await collectChat({
              route,
              provider: model.provider,
              model: modelConcreteId(model, route),
              system:
                "You compress conversations into compaction context. Produce a concise, information-dense summary that captures key facts, decisions, code, names, and open questions so the conversation can continue seamlessly. Use short bullet points." +
                (priorSummary
                  ? `\n\nFold in this earlier summary so nothing is lost:\n${priorSummary}`
                  : ""),
              messages: [
                ...built.messages,
                { role: "user", content: "Summarize everything above as compaction context." },
              ],
              maxTokens: 1024,
              temperature: 0.3,
              keys: state.settings.keys,
            });
            if (summary.trim()) {
              patchNode(nodeId, (n) => {
                // Re-resolve the boundary against the live node in case it grew.
                let at = -1;
                for (let j = n.messages.length - 1; j >= 0; j--) {
                  if (n.messages[j].role === "user") {
                    at = j;
                    break;
                  }
                }
                if (at < 1) return n;
                const comp: Compaction = {
                  id: uid(),
                  atIndex: at,
                  summary: summary.trim(),
                  modelId: n.currentModelId,
                  createdAt: nowISO(),
                };
                return { ...n, compactions: [...n.compactions, comp] };
              });
            }
          } catch {
            /* surfaced to the user via the absence of a new compaction badge */
          } finally {
            set((s) => {
              const next = { ...s.compacting };
              delete next[nodeId];
              return { compacting: next };
            });
          }
        },

        async detectModelWindow(modelId) {
          if (get().modelWindows[modelId]) return;
          const model = getModel(modelId);
          const route = chooseRoute(model.provider, get().settings.keys, get().serverConfig);
          try {
            const res = await fetch("/api/model-window", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: model.provider,
                model: modelConcreteId(model, route),
                fallback: model.contextWindow,
                keys: get().settings.keys,
              }),
            });
            if (!res.ok) return;
            const data = (await res.json()) as { window?: number };
            if (typeof data.window === "number" && data.window > 0) {
              const w = data.window;
              set((s) => ({ modelWindows: { ...s.modelWindows, [modelId]: w } }));
            }
          } catch {
            /* keep the catalog fallback */
          }
        },
      };
    },
    {
      name: STORE_NAME,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // localStorage is the source of truth: persist every chat and its tree.
      // Generated images are large base64 data URLs; persisting them would blow
      // the ~5MB localStorage quota, so keep only remote (http) image URLs.
      partialize: (s) => ({
        chats: s.chats,
        nodes: stripInlineImages(s.nodes),
        chatOrder: s.chatOrder,
        activeChatId: s.activeChatId,
        settings: s.settings,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<StoreState>;
        const settings = { ...current.settings, ...(p.settings ?? {}) };
        settings.lineSpacing = Math.min(
          LINE_SPACING_MAX,
          Math.max(LINE_SPACING_MIN, Number(settings.lineSpacing) || DEFAULT_SETTINGS.lineSpacing),
        );
        return {
          ...current,
          chats: p.chats ?? {},
          nodes: p.nodes ?? {},
          chatOrder: p.chatOrder ?? [],
          activeChatId: p.activeChatId ?? null,
          settings,
        };
      },
    },
  ),
);
