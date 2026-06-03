import type { ApiKeys, Provider, Route, ServerConfig } from "./types";

/**
 * Maximum thread *depth*: the main conversation (depth 0) can spawn a thread
 * (depth 1), which can spawn one more sub-thread (depth 2) - "but that's it".
 * A node may branch only while `node.depth < MAX_THREAD_BRANCHING`.
 */
export const MAX_THREAD_BRANCHING = 2;

export interface ProviderMeta {
  label: string;
  company: string;
  /** Accent used for badges/avatars. */
  color: string;
}

/**
 * The canonical provider order, used everywhere a list of providers is rendered
 * or validated. Single source so the chat picker, settings, capability matrix,
 * modality matrix, and the API all agree on the same set and ordering.
 */
export const PROVIDER_ORDER: Provider[] = ["anthropic", "openai", "gemini"];

export const PROVIDERS: Record<Provider, ProviderMeta> = {
  anthropic: { label: "Claude", company: "Anthropic", color: "#c96442" },
  openai: { label: "ChatGPT", company: "OpenAI", color: "#10a37f" },
  gemini: { label: "Gemini", company: "Google", color: "#4285f4" },
};

/**
 * A barely-there background wash carrying a provider's signature color, mixed
 * into the surface so it reads as a faint tinge (just noticeable) in both
 * themes. Used to tint conversation-tree cards by the model that produced them.
 */
export function providerTint(provider: Provider, pct = 7): string {
  return `color-mix(in srgb, ${PROVIDERS[provider].color} ${pct}%, var(--surface))`;
}

/**
 * The same signature-color tinge applied to text: the provider color mixed into
 * a foreground token (ink/muted) so labels pick up a hint of the model's hue
 * while staying readable. Text needs a touch more color than the background
 * wash to read at all, so the default percentage is higher than `providerTint`.
 */
export function providerInk(provider: Provider, pct = 22, base = "--ink"): string {
  return `color-mix(in srgb, ${PROVIDERS[provider].color} ${pct}%, var(${base}))`;
}

export type ModelSize = "small" | "medium" | "large" | "xlarge";

export interface ModelDef {
  /** Stable catalog id; equals the interpret tier key (e.g. "cl-large"). */
  id: string;
  provider: Provider;
  size: ModelSize;
  /** Interpret backend tier key. */
  interpretTier: string;
  /** Concrete model the interpret tier resolves to (for display). */
  interpretModel: string;
  /** Display name when routed through interpret. */
  interpretLabel: string;
  /** Concrete model id for a direct BYO-key call. */
  directModel: string;
  /** Display name when routed directly. */
  directLabel: string;
  /**
   * Max input context window in tokens. Curated fallback; refined at runtime by
   * `/api/model-window` where a provider's models API exposes the real limit
   * (Gemini returns `inputTokenLimit`). Drives auto-compaction.
   */
  contextWindow: number;
}

/**
 * The full catalog: 12 interpret tiers, each with the concrete model the
 * interpret backend resolves to and the best public model id for a direct call.
 * Direct ids are verified-available public ids.
 */
export const MODELS: ModelDef[] = [
  // -- Claude (Anthropic) --
  { id: "cl-small", provider: "anthropic", size: "small", interpretTier: "cl-small", interpretModel: "claude-haiku-3-5", interpretLabel: "Claude Haiku 3.5", directModel: "claude-haiku-4-5-20251001", directLabel: "Claude Haiku 4.5", contextWindow: 200_000 },
  { id: "cl-medium", provider: "anthropic", size: "medium", interpretTier: "cl-medium", interpretModel: "claude-sonnet-4-5", interpretLabel: "Claude Sonnet 4.5", directModel: "claude-sonnet-4-6", directLabel: "Claude Sonnet 4.6", contextWindow: 200_000 },
  { id: "cl-large", provider: "anthropic", size: "large", interpretTier: "cl-large", interpretModel: "claude-opus-4-8", interpretLabel: "Claude Opus 4.8", directModel: "claude-opus-4-8", directLabel: "Claude Opus 4.8", contextWindow: 200_000 },
  { id: "cl-xlarge", provider: "anthropic", size: "xlarge", interpretTier: "cl-xlarge", interpretModel: "claude-opus-4-8", interpretLabel: "Claude Opus 4.8 (1M)", directModel: "claude-opus-4-8", directLabel: "Claude Opus 4.8 (1M)", contextWindow: 1_000_000 },
  // -- ChatGPT (OpenAI) --
  { id: "gp-small", provider: "openai", size: "small", interpretTier: "gp-small", interpretModel: "gpt-5.4-nano", interpretLabel: "GPT-5.4 nano", directModel: "gpt-5.4-nano", directLabel: "GPT-5.4 nano", contextWindow: 400_000 },
  { id: "gp-medium", provider: "openai", size: "medium", interpretTier: "gp-medium", interpretModel: "gpt-5.4-mini", interpretLabel: "GPT-5.4 mini", directModel: "gpt-5.4-mini", directLabel: "GPT-5.4 mini", contextWindow: 400_000 },
  { id: "gp-large", provider: "openai", size: "large", interpretTier: "gp-large", interpretModel: "gpt-5.5", interpretLabel: "GPT-5.5", directModel: "gpt-5.5", directLabel: "GPT-5.5", contextWindow: 400_000 },
  { id: "gp-xlarge", provider: "openai", size: "xlarge", interpretTier: "gp-xlarge", interpretModel: "gpt-5.5-pro", interpretLabel: "GPT-5.5 pro", directModel: "gpt-5.5-pro", directLabel: "GPT-5.5 pro", contextWindow: 400_000 },
  // -- Gemini (Google) --
  { id: "ge-small", provider: "gemini", size: "small", interpretTier: "ge-small", interpretModel: "gemini-3.1-flash-lite", interpretLabel: "Gemini 3.1 Flash Lite", directModel: "gemini-3.1-flash-lite", directLabel: "Gemini 3.1 Flash Lite", contextWindow: 1_000_000 },
  { id: "ge-medium", provider: "gemini", size: "medium", interpretTier: "ge-medium", interpretModel: "gemini-3.5-flash", interpretLabel: "Gemini 3.5 Flash", directModel: "gemini-3.5-flash", directLabel: "Gemini 3.5 Flash", contextWindow: 1_000_000 },
  { id: "ge-large", provider: "gemini", size: "large", interpretTier: "ge-large", interpretModel: "gemini-3.1-pro-preview", interpretLabel: "Gemini 3.1 Pro", directModel: "gemini-3.1-pro-preview", directLabel: "Gemini 3.1 Pro", contextWindow: 1_000_000 },
  { id: "ge-xlarge", provider: "gemini", size: "xlarge", interpretTier: "ge-xlarge", interpretModel: "gemini-3.1-pro-preview", interpretLabel: "Gemini 3.1 Pro", directModel: "gemini-3.1-pro-preview", directLabel: "Gemini 3.1 Pro", contextWindow: 1_000_000 },
];

export const SIZE_LABEL: Record<ModelSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xlarge: "XLarge",
};

const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export function getModel(id: string): ModelDef {
  return MODEL_BY_ID.get(id) ?? MODELS[0];
}

/** Default model the app starts on. Gemini 3.5 Flash works live through interpret on staging. */
export const DEFAULT_MODEL_ID = "ge-medium";

/**
 * Decide how a model should be dispatched given the keys available.
 *
 * - Gemini routes through interpret (served live on staging) unless the user
 *   has supplied their own Gemini key.
 * - Claude/ChatGPT prefer a direct call whenever a key exists (client BYO key
 *   or a server-side fallback), since the interpret backend may not hold those
 *   provider keys; otherwise they fall back to interpret.
 */
export function chooseRoute(
  provider: Provider,
  clientKeys: ApiKeys,
  serverConfig: ServerConfig | null,
): Route {
  const hasClientDirect = Boolean(clientKeys[provider]);
  const hasServerDirect = Boolean(serverConfig?.[provider]);
  if (provider === "gemini") {
    return hasClientDirect ? "direct" : "interpret";
  }
  return hasClientDirect || hasServerDirect ? "direct" : "interpret";
}

export function modelLabel(model: ModelDef, route: Route): string {
  return route === "direct" ? model.directLabel : model.interpretLabel;
}

/**
 * The label a model should show given the keys available — i.e. the name of the
 * model the user will actually reach. Use this anywhere a model is presented to
 * the user (chat picker, settings) so those surfaces never diverge.
 */
export function modelLabelFor(model: ModelDef, keys: ApiKeys, cfg: ServerConfig | null): string {
  return modelLabel(model, chooseRoute(model.provider, keys, cfg));
}

export function modelConcreteId(model: ModelDef, route: Route): string {
  return route === "direct" ? model.directModel : model.interpretTier;
}

export const MODELS_BY_PROVIDER: { provider: Provider; models: ModelDef[] }[] =
  PROVIDER_ORDER.map((provider) => ({
    provider,
    models: MODELS.filter((m) => m.provider === provider),
  }));
