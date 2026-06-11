/**
 * TOOL_MARKETPLACE.md phase M2: `manifestToToolDefs()` — every registered
 * webhook manifest becomes a provider-agnostic, model-callable tool definition
 * for the chat loop. Provider adapters (`server/providers.ts`) translate these
 * into their native tool format (Anthropic `input_schema`, OpenAI
 * `function.parameters`, Gemini `function_declarations`).
 *
 * Design rules (from the marketplace notes):
 *
 * - **Namespacing**: function names are `<toolId>__<fn>` so two tools can
 *   declare the same function name without colliding.
 * - **Union degradation — strip, don't block**: a binding whose declared
 *   `auth.secrets` env vars are not configured on this server is *stripped*
 *   from the defs list for the request — the model never sees it and keeps
 *   working with the rest. It is never surfaced as a mid-loop error.
 * - **One seam**: dispatch goes through the same `invokeTool` the
 *   `/api/tools/[tool]` bridge uses, so metering/telemetry live in one place.
 * - **Normalizer owns the copy**: `runToolDef` never throws; failures come
 *   back to the model as `{ error }` with OUR copy (`ToolError` messages),
 *   never raw vendor prose.
 */
import { TOOL_NAME_SEP, ToolError, type ToolManifest } from "./manifest";
import { getToolManifest, invokeTool, TOOL_MANIFESTS } from "./registry";

export { TOOL_NAME_SEP } from "./manifest";

/** A provider-agnostic tool definition the chat loop hands to an adapter. */
export interface ProviderToolDef {
  /** Namespaced `<toolId>__<fn>`, e.g. `web_scrape__scrape_url`. */
  name: string;
  description: string;
  /** JSON Schema for the arguments object, straight from the manifest. */
  parameters: Record<string, unknown>;
}

/**
 * Whether a manifest's binding is usable on this server: every env var named
 * in `auth.secrets` is set (names only — values never leave this check).
 * Keyless tools (no `secrets`) are always configured.
 */
export function isToolConfigured(manifest: ToolManifest): boolean {
  return (manifest.auth.secrets ?? []).every((name) => {
    const v = process.env[name];
    return Boolean(v && v.trim());
  });
}

/**
 * Map registered manifests to model-callable tool definitions. Evaluated per
 * request: IAI-bound manifests are skipped (not locally invokable), and
 * unconfigured/BYOK-missing bindings are STRIPPED so the model never sees a
 * tool it cannot call.
 */
export function manifestToToolDefs(
  manifests: ToolManifest[] = TOOL_MANIFESTS,
): ProviderToolDef[] {
  const defs: ProviderToolDef[] = [];
  for (const m of manifests) {
    if (m.binding.kind !== "webhook") continue;
    if (!isToolConfigured(m)) continue; // strip, never error mid-loop
    for (const fn of m.binding.functions) {
      defs.push({
        name: `${m.id}${TOOL_NAME_SEP}${fn.name}`,
        // The per-function description plus the manifest's agent blurb: both
        // are prompt text, and together they say what the fn does AND when
        // the agent should reach for this toolset.
        description: `${fn.description}\n${m.description}`,
        parameters: fn.parameters,
      });
    }
  }
  return defs;
}

/**
 * Resolve a namespaced tool name back to `{ toolId, fn }` against the
 * registry (ids can contain single underscores, so we match by registered id
 * prefix rather than splitting blindly). Null when the name is not ours.
 */
export function parseToolDefName(
  name: string,
): { toolId: string; fn: string } | null {
  for (const m of TOOL_MANIFESTS) {
    const prefix = m.id + TOOL_NAME_SEP;
    if (name.startsWith(prefix)) {
      return { toolId: m.id, fn: name.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * Execute one model tool call through the registry dispatch seam. NEVER
 * throws: the chat loop must keep streaming, so failures are returned to the
 * model as `{ error }` data using our normalized copy.
 */
export async function runToolDef(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const parsed = parseToolDefName(name);
  if (!parsed) return { error: `Unknown tool: ${name}` };
  try {
    const result = await invokeTool(parsed.toolId, parsed.fn, args);
    return result ?? null;
  } catch (e) {
    // ToolError messages are written by us (the binding / registry); anything
    // else gets generic copy so raw vendor prose never reaches the model/UI.
    return {
      error: e instanceof ToolError ? e.message : "Tool invocation failed",
    };
  }
}

/**
 * Resolve a model-emitted tool name to TRUSTED display strings — the label and
 * the fn name come from the registered manifest, never echoed from the model.
 * Null when the name doesn't resolve to a registered tool + declared function.
 */
function resolveToolDefDisplay(name: string): { label: string; fn: string } | null {
  const parsed = parseToolDefName(name);
  if (!parsed) return null;
  const manifest = getToolManifest(parsed.toolId);
  if (!manifest || manifest.binding.kind !== "webhook") return null;
  const fn = manifest.binding.functions.find((f) => f.name === parsed.fn);
  if (!fn) return null;
  return { label: manifest.display.label, fn: fn.name };
}

/**
 * Status line shown while a tool call runs. The model-emitted name is never
 * shown verbatim (hostile model output must not reach the UI): it is resolved
 * against the registered defs first, and an unknown name degrades to a
 * generic line.
 */
export function toolDefStatusText(name: string): string {
  const display = resolveToolDefDisplay(name);
  return display ? `Running ${display.label} (${display.fn})…` : "Running tool…";
}

/**
 * Human trace line for the activity log, e.g. `Used Web scrape (scrape_url)`.
 * Same rule as the status line: only registry-owned strings, never the raw
 * model-emitted name.
 */
export function toolDefTraceText(name: string): string {
  const display = resolveToolDefDisplay(name);
  return display ? `Used ${display.label} (${display.fn})` : "Used a community tool";
}
