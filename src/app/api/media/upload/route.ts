import type { NextRequest } from "next/server";
import { iaiStoreEnabled } from "@/lib/flags";
import { presignMediaPut } from "@/lib/server/iai";
import { clientIp, rateLimit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Burst backstop for media presign requests, per IP. */
const UPLOAD_BURST_LIMIT = Number(process.env.UPLOAD_BURST_LIMIT) || 60;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Thin proxy to IAI's generic, content-addressed S3 presign route
 * (POST /api/v1/cloud/aws/s3/presigned-put). We forward {sha256, content_type,
 * size_bytes} with the interpret credential; the browser then PUTs the bytes
 * straight to S3 with the returned presigned URL (bytes never touch this pod).
 * Media storage is generic path+bytes - we reuse the shared route rather than a
 * ProperChat-specific endpoint (see memory iai-asset-storage-generic-s3).
 *
 * Gated by NEXT_PUBLIC_IAI_STORE so the client falls back to an inline data: URL
 * until storage is enabled and the IAI route is deployed.
 */
export async function POST(req: NextRequest) {
  if (!iaiStoreEnabled()) return Response.json({ ok: false, reason: "disabled" }, { status: 503 });

  const rl = rateLimit(`upload:ip:${clientIp(req)}`, UPLOAD_BURST_LIMIT, 60_000);
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

  const sha256 = typeof body.sha256 === "string" ? body.sha256 : "";
  const contentType = typeof body.content_type === "string" ? body.content_type : "";
  const sizeBytes = typeof body.size_bytes === "number" ? body.size_bytes : 0;
  if (!/^[0-9a-f]{64}$/.test(sha256) || !contentType || sizeBytes <= 0) {
    return new Response("Missing/invalid sha256, content_type, or size_bytes", { status: 400 });
  }

  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const credential =
    typeof keys.interpret === "string" && keys.interpret.trim()
      ? keys.interpret.trim()
      : env("INTERPRETAI_API_KEY");
  if (!credential) return Response.json({ ok: false, reason: "no-credential" }, { status: 503 });

  const result = await presignMediaPut(credential, {
    sha256,
    content_type: contentType,
    size_bytes: sizeBytes,
  });
  if (!result) return Response.json({ ok: false, reason: "unavailable" }, { status: 502 });
  return Response.json(result);
}
