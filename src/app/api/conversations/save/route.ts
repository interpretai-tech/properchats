import type { NextRequest } from "next/server";
import { iaiStoreEnabled } from "@/lib/flags";
import { saveConversationTree } from "@/lib/server/iai";
import { clientIp, rateLimit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Burst backstop for conversation-tree sync writes, per IP. */
const SYNC_BURST_LIMIT = Number(process.env.CONV_SYNC_BURST_LIMIT) || 120;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Persist one chat's conversation tree to IAI. The browser POSTs the tree
 * (a generic IAI Tree dict carrying ProperChat data in node `meta`); this
 * route forwards it with the server-side interpret credential so the IAI key
 * never reaches the client. Gated by NEXT_PUBLIC_IAI_STORE so sync is opt-in.
 */
export async function POST(req: NextRequest) {
  if (!iaiStoreEnabled()) return Response.json({ ok: false, reason: "disabled" }, { status: 503 });

  const rl = rateLimit(`convsave:ip:${clientIp(req)}`, SYNC_BURST_LIMIT, 60_000);
  if (!rl.ok) {
    return Response.json(
      { ok: false, reason: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : "";
  const tree = body.tree;
  if (!conversationId || !tree || typeof tree !== "object") {
    return new Response("Missing/invalid conversation_id or tree", { status: 400 });
  }

  const credential = env("INTERPRETAI_API_KEY");
  if (!credential) return Response.json({ ok: false, reason: "no-credential" }, { status: 503 });

  const ok = await saveConversationTree(credential, conversationId, tree);
  return Response.json({ ok });
}
