import { getModel, MODELS, PROVIDER_ORDER } from "./models";
import type { ApiKeys, Capability, Provider, ServerConfig } from "./types";

/**
 * Provider-native "agent" capabilities. ProperChat exposes the same extra
 * functions the first-party apps do (ChatGPT image gen / deep research, web
 * search across all three, code interpreter) by passing them through to each
 * provider's server-side tools. This module is the shared, secret-free source of
 * truth used by both the client (picker + turn planning) and the server
 * (capability dispatch).
 *
 * A capability other than "chat" always runs as a *direct* provider call: the
 * interpret backend only speaks plain messages, so tools require a BYO or
 * server key for a provider that natively supports the capability.
 */

export interface CapabilityMeta {
  id: Capability;
  label: string;
  /** One-line hint shown in the picker. */
  hint: string;
  /** lucide-react icon name, resolved in the picker. */
  icon: "MessageSquare" | "Globe" | "Image" | "Telescope" | "Terminal";
  /** Providers that natively serve this capability, in fallback preference order. */
  providers: Provider[];
}

export const CAPABILITIES: CapabilityMeta[] = [
  {
    id: "chat",
    label: "Chat",
    hint: "Standard conversation",
    icon: "MessageSquare",
    providers: ["anthropic", "openai", "gemini"],
  },
  {
    id: "web_search",
    label: "Web search",
    hint: "Answer using live web results, with citations",
    icon: "Globe",
    providers: ["openai", "anthropic", "gemini"],
  },
  {
    id: "image",
    label: "Image",
    hint: "Generate images from a prompt",
    icon: "Image",
    providers: ["openai", "gemini"],
  },
  {
    id: "deep_research",
    label: "Deep research",
    hint: "Multi-step researched report with sources",
    icon: "Telescope",
    providers: ["openai"],
  },
  {
    id: "code",
    label: "Code interpreter",
    hint: "Run code in a sandbox to compute the answer",
    icon: "Terminal",
    providers: ["openai", "anthropic", "gemini"],
  },
];

/** Every capability id, in catalog order. Single source for validation/iteration. */
export const CAPABILITY_IDS: Capability[] = CAPABILITIES.map((c) => c.id);

const CAP_BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function getCapability(id: Capability): CapabilityMeta {
  return CAP_BY_ID.get(id) ?? CAPABILITIES[0];
}

/** Special model ids used only when a capability requires a dedicated model. */
export const DEEP_RESEARCH_MODEL = "o4-mini-deep-research";
export const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

/** Best general-purpose direct model id per provider (the catalog's "large" tier). */
function defaultDirectModel(provider: Provider): string {
  const m =
    MODELS.find((x) => x.provider === provider && x.size === "large") ??
    MODELS.find((x) => x.provider === provider);
  return m!.directModel;
}

/** Whether a given provider can serve a capability natively. */
export function providerSupports(provider: Provider, cap: Capability): boolean {
  return getCapability(cap).providers.includes(provider);
}

export type Availability = Record<Provider, boolean>;

/**
 * Which providers currently have a usable key: a local BYO client key or a
 * server-side fallback key configured on the deployment.
 */
export function providerAvailability(keys: ApiKeys, cfg: ServerConfig | null): Availability {
  return Object.fromEntries(
    PROVIDER_ORDER.map((p) => [p, Boolean(keys[p] || cfg?.[p])]),
  ) as Availability;
}

/**
 * Pick the provider that should serve `cap` given which providers currently have
 * a usable key. Prefers the user's selected provider when it supports the
 * capability and has a key, then the first supporting provider with a key, then
 * the first supporting provider at all (so the server can return a clear
 * "needs a key" error rather than silently doing nothing).
 */
export function pickCapabilityProvider(
  cap: Capability,
  selected: Provider,
  avail: Availability,
): Provider {
  const supporting = getCapability(cap).providers;
  if (supporting.includes(selected) && avail[selected]) return selected;
  const withKey = supporting.find((p) => avail[p]);
  if (withKey) return withKey;
  return supporting.includes(selected) ? selected : supporting[0];
}

export interface ResolvedCapability {
  provider: Provider;
  /** Concrete model id to send (a direct provider id, possibly a capability-specific one). */
  model: string;
  route: "direct";
  /** Friendly label for the message tag. */
  modelName: string;
}

/**
 * Resolve the concrete provider/model/route for a capability turn. `chat`
 * returns null — the caller should use the normal chat path for that.
 */
export function resolveCapability(
  cap: Capability,
  selectedModelId: string,
  avail: Availability,
): ResolvedCapability | null {
  if (cap === "chat") return null;
  const selected = getModel(selectedModelId);
  const provider = pickCapabilityProvider(cap, selected.provider, avail);

  let model: string;
  if (cap === "deep_research") {
    model = DEEP_RESEARCH_MODEL;
  } else if (cap === "image" && provider === "gemini") {
    model = GEMINI_IMAGE_MODEL;
  } else if (provider === selected.provider) {
    model = selected.directModel;
  } else {
    model = defaultDirectModel(provider);
  }

  return { provider, model, route: "direct", modelName: capabilityModelName(cap, provider, model) };
}

/** A short, human label for the message tag, e.g. "GPT-5 · Image". */
export function capabilityModelName(cap: Capability, provider: Provider, model: string): string {
  const catalog = MODELS.find((m) => m.directModel === model);
  const base = catalog?.directLabel ?? model;
  if (cap === "chat") return base;
  return `${base} · ${getCapability(cap).label}`;
}

/** True if at least one supporting provider has a usable key. */
export function capabilityAvailable(cap: Capability, avail: Availability): boolean {
  if (cap === "chat") return true;
  return getCapability(cap).providers.some((p) => avail[p]);
}
