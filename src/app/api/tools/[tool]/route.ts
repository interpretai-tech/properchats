import type { NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/lib/server/rateLimit";
import { ToolError } from "@/lib/tools/manifest";
import { getToolManifest, invokeTool } from "@/lib/tools/registry";

/**
 * The webhook bridge from docs/PUBLIC_TOOL_ECOSYSTEM.md: webhook-bound tool
 * manifests declare JSON-schema'd functions, and this route executes them
 * server-side (any secrets stay in env; today's launch tools are keyless).
 *
 *   GET  /api/tools/<id>  → the tool's manifest (secret-free discovery)
 *   POST /api/tools/<id>  → { "function": "get_weather", "args": { ... } }
 *                         → { ok: true, tool, function, result }
 *
 * POST is gated: JSON-only Content-Type (415), no cross-site browser callers
 * (403 when Origin/Sec-Fetch-Site say another site; absent headers = allowed
 * programmatic caller), per-IP burst limit, and a per-tool hourly budget for
 * BYOK-metered tools. See the constants and helpers below.
 */

/** Burst backstop, per IP across all tools (process-local; see rateLimit.ts). */
const TOOLS_BURST_LIMIT = Number(process.env.TOOLS_BURST_LIMIT) || 30;
const TOOLS_BURST_WINDOW_MS = 60_000;

/**
 * Stricter budget for BYOK-metered tools (manifests declaring auth.secrets):
 * those calls burn a metered vendor key, so on top of the per-IP burst limit
 * each such tool gets a process-local calls-per-hour ceiling across ALL
 * callers. Crude but it bounds single-instance key burn; like rateLimit.ts it
 * is process-local, so a multi-instance / serverless deploy multiplies the
 * effective ceiling by the instance count — a durable global budget needs a
 * shared store (Vercel KV / Upstash). Keyless tools are unaffected.
 */
const TOOLS_BYOK_TOOL_LIMIT = Number(process.env.TOOLS_BYOK_TOOL_LIMIT) || 60;
const TOOLS_BYOK_TOOL_WINDOW_MS = 3_600_000;

/**
 * Browser cross-site posture: this route is unauthenticated by design (the
 * public bridge), but it must not be drivable from a hostile page in someone
 * else's browser. Two gates, both BEFORE the body is read:
 *
 * 1. Content-Type must be application/json (415 otherwise). A cross-origin
 *    "simple request" (text/plain, no preflight) can therefore never reach a
 *    binding — JSON forces a CORS preflight, which we never answer.
 * 2. When the caller DOES present browser provenance headers and they
 *    indicate another site (Sec-Fetch-Site: cross-site, or an Origin whose
 *    host differs from this request's Host), reject 403. ABSENT headers mean
 *    a programmatic caller (curl, server-to-server) — deliberately allowed:
 *    the bridge is a public API, and a non-browser client can fake any header
 *    anyway, so this check only exists to stop CSRF-style browser abuse.
 */
function crossSiteRejection(req: NextRequest): Response | null {
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "same-site" && sfs !== "none") {
    return Response.json({ error: "Cross-site browser calls are not allowed" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      /* "null" or malformed Origin → rejected below */
    }
    if (!originHost || !host || originHost !== host.trim()) {
      return Response.json({ error: "Cross-site browser calls are not allowed" }, { status: 403 });
    }
  }
  return null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ tool: string }> },
) {
  const { tool } = await params;
  const manifest = getToolManifest(tool);
  if (!manifest) return Response.json({ error: `Unknown tool: ${tool}` }, { status: 404 });
  return Response.json(manifest);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ tool: string }> },
) {
  const { tool } = await params;

  // Order matters: the browser-abuse gates run before any rate-limit state is
  // touched, so a CSRF probe can't even consume a caller's budget.
  const contentType = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return Response.json(
      { error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }
  const rejected = crossSiteRejection(req);
  if (rejected) return rejected;

  const rl = rateLimit(`tools:ip:${clientIp(req)}`, TOOLS_BURST_LIMIT, TOOLS_BURST_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  // BYOK-metered tools additionally consume the per-tool hourly budget (see
  // TOOLS_BYOK_TOOL_LIMIT above) — every accepted call may bill the host's
  // vendor key, so the per-IP backstop alone is not enough.
  const manifest = getToolManifest(tool);
  if (!manifest) return Response.json({ error: `Unknown tool: ${tool}` }, { status: 404 });
  if (manifest.auth.secrets?.length) {
    const budget = rateLimit(
      `tools:byok:${manifest.id}`,
      TOOLS_BYOK_TOOL_LIMIT,
      TOOLS_BYOK_TOOL_WINDOW_MS,
    );
    if (!budget.ok) {
      return Response.json(
        { error: `The ${manifest.id} tool has reached its hourly budget. Try again later.` },
        { status: 429, headers: { "Retry-After": String(budget.retryAfter) } },
      );
    }
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const fn = typeof body.function === "string" ? body.function : "";
  if (!fn) return Response.json({ error: "Missing function" }, { status: 400 });
  const args =
    body.args && typeof body.args === "object" && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {};

  try {
    const result = await invokeTool(tool, fn, args);
    return Response.json({ ok: true, tool, function: fn, result });
  } catch (e) {
    if (e instanceof ToolError) {
      return Response.json({ ok: false, error: e.message }, { status: e.status });
    }
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "Tool invocation failed" },
      { status: 500 },
    );
  }
}
