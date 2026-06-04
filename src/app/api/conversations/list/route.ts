import type { NextRequest } from "next/server";
import { iaiStoreEnabled } from "@/lib/flags";
import { listConversationTrees } from "@/lib/server/iai";
import { clientIp, rateLimit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Burst backstop for conversation-tree listing, per IP. */
const LIST_BURST_LIMIT = Number(process.env.CONV_LIST_BURST_LIMIT) || 30;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * List every conversation tree for the deployment's org, used to repopulate
 * the workspace on a cold cache. Org-wide, so it uses the server-side
 * interpret credential only (never a browser-supplied key). Returns 503 when
 * sync is disabled or unconfigured so the client cleanly stays localStorage-only.
 */
export async function GET(req: NextRequest) {
  if (!iaiStoreEnabled()) {
    return Response.json({ ok: false, reason: "disabled", trees: [] }, { status: 503 });
  }

  const rl = rateLimit(`convlist:ip:${clientIp(req)}`, LIST_BURST_LIMIT, 60_000);
  if (!rl.ok) {
    return Response.json(
      { ok: false, reason: "rate-limited", trees: [] },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const credential = env("INTERPRETAI_API_KEY");
  if (!credential) {
    return Response.json({ ok: false, reason: "no-credential", trees: [] }, { status: 503 });
  }

  const trees = await listConversationTrees(credential);
  return Response.json({ trees });
}
