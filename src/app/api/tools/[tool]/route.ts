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
 */

/** Burst backstop, per IP across all tools (process-local; see rateLimit.ts). */
const TOOLS_BURST_LIMIT = Number(process.env.TOOLS_BURST_LIMIT) || 30;
const TOOLS_BURST_WINDOW_MS = 60_000;

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

  const rl = rateLimit(`tools:ip:${clientIp(req)}`, TOOLS_BURST_LIMIT, TOOLS_BURST_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
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
