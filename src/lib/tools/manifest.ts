/**
 * The tool-manifest contract from docs/PUBLIC_TOOL_ECOSYSTEM.md §2.2, as code.
 *
 * A manifest declares in one object everything a capability otherwise spreads
 * across five files (union member, registry entry, tool-token map, policy row,
 * sign-in copy). The doc's worked example is mail; this module is the typed
 * counterpart so real tools can register through `registry.ts`.
 *
 * Two binding kinds exist today:
 *
 * - `iai-toolset` — the tool's agent logic lives in the upstream IAI ("Sauron")
 *   runtime; ProperChat only forwards the native-tool token. Not locally
 *   invokable from this repo (see `invokeTool` in registry.ts).
 * - `webhook` — a ProperChat-hosted bridge endpoint executes JSON-schema'd
 *   functions server-side (proxying a third-party API, or running an embedded
 *   library), with any secrets resolved from env on the server. The bridge for
 *   registered tools is mounted at `/api/tools/[tool]`.
 */

export type Tier = "free" | "basic" | "monthly" | "insane";

/** A JSON-schema'd function a webhook-bound tool exposes to the agent. */
export interface WebhookFunctionDecl {
  name: string;
  /** What the function does + when the agent should call it. */
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export type ToolBinding =
  | {
      kind: "iai-toolset";
      /** Native-tool token forwarded as tools:[token] to messages/stream. */
      token: string;
    }
  | {
      kind: "webhook";
      /** Bridge endpoint, e.g. "/api/tools/weather" (ProperChat-hosted). */
      endpoint: string;
      functions: WebhookFunctionDecl[];
    };

export interface ToolManifest {
  // ── Identity ──────────────────────────────────────────────────────────────
  /** Wire token. Persisted forever — never reuse or rename (alias instead). */
  id: string;
  /** Ids this tool supersedes (merged into the legacy alias map). */
  aliases?: string[];

  // ── Display (CapabilityMeta-shaped) ──────────────────────────────────────
  display: {
    label: string;
    /** One-line picker hint. */
    hint: string;
    /** lucide-react icon name. */
    icon: string;
    experimental?: boolean;
  };

  /** System-prompt blurb teaching the agent when/how to use the toolset. */
  description: string;

  // ── Invocation binding ────────────────────────────────────────────────────
  binding: ToolBinding;
  /** Providers that can host the agent turn. */
  providers: ("anthropic" | "openai" | "gemini")[];

  // ── Auth & secrets ────────────────────────────────────────────────────────
  auth: {
    requiresSignIn: boolean;
    /** Env var NAMES the binding needs server-side (never values). */
    secrets?: string[];
    /** ServerConfig flag exposing "configured on this server" to the picker. */
    configFlag?: string;
  };

  // ── Limits / billing (a CAPABILITY_POLICY row) ───────────────────────────
  policy: {
    /** Per-tier monthly allowance; env-overridable as ${TIER}_${ID}_LIMIT. */
    allowance: Record<Tier, number | "blocked" | "unmetered">;
    meterMode: "per-turn" | "on-success" | "on-accept";
    /** Tool-name regex source for on-success metering. */
    meterOn?: string;
    ownKeyExempt?: boolean;
    creditsFallback?: boolean;
    blockedCopy?: string;
    quotaCopy?: string;
  };

  // ── UI slots (absent ⇒ prose-only) ───────────────────────────────────────
  ui?: {
    card?: { payloadKey: string; component: string };
    vizRoute?: { page: string; api?: string[] };
    jobTracePattern?: string;
  };

  // ── Attribution (open-source tools) ──────────────────────────────────────
  /** Upstream project this tool wraps, for credit and license compliance. */
  upstream?: {
    project: string;
    repo: string;
    license: string;
    author: string;
  };

  // ── Marketplace listing (TOOL_MARKETPLACE.md M1) ─────────────────────────
  /** Catalog grouping, e.g. "data", "media", "productivity", "finance". */
  category?: string;
  /** How the binding is paid for: no key at all, bring-your-own-key, or
   *  metered against the host's CAPABILITY_POLICY allowances. */
  pricing?: "keyless" | "byok" | "metered";
  /** GitHub handle of the binding's maintainer (the PR author). */
  maintainer?: string;
}

/** Error with an HTTP status hint, thrown by bindings and the registry. */
export class ToolError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ToolError";
    this.status = status;
  }
}
