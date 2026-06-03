/**
 * Best-effort in-memory, per-key fixed-window rate limiter for the public proxy
 * routes (/api/chat, /api/media/upload, /api/suggestions).
 *
 * IMPORTANT: this is process-local. On a multi-instance / serverless deploy
 * each instance keeps its own counters, so it is a coarse abuse backstop, not a
 * precise global limit. Durable, distributed limiting needs a shared store
 * (e.g. Vercel KV / Upstash).
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
// Bound memory: opportunistically evict expired buckets past this many keys.
const MAX_TRACKED = 50_000;

export interface RateResult {
  ok: boolean;
  /** Seconds until the window resets (for a Retry-After header). */
  retryAfter: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    if (buckets.size > MAX_TRACKED) {
      for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }

  if (bucket.count >= limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  bucket.count += 1;
  return { ok: true, retryAfter: 0 };
}

/** Best-effort client IP: first hop of x-forwarded-for, else x-real-ip. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
