import { type NextRequest, NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
// Freshness is managed in-memory below (an hourly pool + last-good), so the
// handler must run on every request rather than be full-route cached - that way
// a transient upstream outage is never frozen into the cached response.
export const dynamic = "force-dynamic";

export interface Suggestion {
  text: string;
  /** Link to the thread this question came from. */
  url: string;
  /** Human label of the source, e.g. "Stack Overflow". */
  source: string;
}

/**
 * Real questions people are actually asking, pooled live from public Q&A
 * communities (Stack Exchange "hot" questions across a few sites, plus Ask HN).
 * Each suggestion links back to its thread so you can see where it came from.
 *
 * We refresh from the upstreams at most once an hour and hold the last good pool
 * in memory; if every upstream is unreachable we keep serving that pool rather
 * than substituting generic prompts. On a cold start with no pool yet we return
 * an empty list and let the client fall back to its own locally-cached questions
 * (see ChatPane's Hero).
 *
 * (Reddit's JSON endpoints now 403 unauthenticated/datacenter requests, so we
 * use sources that serve a stable public API.)
 */
const SE_SITES: { site: string; label: string }[] = [
  { site: "stackoverflow", label: "Stack Overflow" },
  { site: "english", label: "English SE" },
  { site: "superuser", label: "Super User" },
];

// In-memory pool for this server instance, refreshed at most once an hour. We
// never replace it with generic prompts: on a failed refresh we keep the last
// good pool and just retry sooner.
const REFRESH_MS = 3_600_000; // hold a good pool for an hour, then refresh
const RETRY_MS = 60_000; // after a failed/empty refresh, retry soon (not every hit)
let pool: Suggestion[] = [];
let nextRefreshAt = 0;
let inflight: Promise<Suggestion[]> | null = null;

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&hellip;/g, "…")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function usable(title: string): boolean {
  if (title.length < 12 || title.length > 110) return false;
  // Keep genuine questions: they make the best starter prompts.
  return (
    /\?$/.test(title) ||
    /^(how|why|what|when|where|who|whose|is|are|can|could|should|does|do|did|which|would|will)\b/i.test(
      title,
    )
  );
}

async function fromStackExchange({ site, label }: { site: string; label: string }): Promise<Suggestion[]> {
  const url = `https://api.stackexchange.com/2.3/questions?order=desc&sort=hot&pagesize=12&site=${site}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: { title?: string; link?: string }[] };
  return (data.items ?? [])
    .map((q) => ({ text: decodeEntities(q.title ?? ""), url: q.link ?? "", source: label }))
    .filter((s) => usable(s.text) && s.url);
}

async function fromHackerNews(): Promise<Suggestion[]> {
  const url =
    "https://hn.algolia.com/api/v1/search?tags=ask_hn&numericFilters=points%3E30&hitsPerPage=20";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { hits?: { title?: string; objectID?: string }[] };
  return (data.hits ?? [])
    .map((h) => ({ title: h.title ?? "", id: h.objectID ?? "" }))
    .filter((h) => /^ask hn:/i.test(h.title))
    .map((h) => {
      const text = decodeEntities(h.title.replace(/^ask hn:?\s*/i, ""));
      return { text, url: `https://news.ycombinator.com/item?id=${h.id}`, source: "Hacker News" };
    })
    .filter(
      (s) =>
        usable(s.text) &&
        !/who('?s| is) hiring|who wants to be hired|freelancer\?? seeking/i.test(s.text),
    );
}

/** Round-robin across sources so the four suggestions feel varied. */
function pickSpread(groups: Suggestion[][], n: number): Suggestion[] {
  const queues = groups.map((g) => [...g]);
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (out.length < n && queues.some((q) => q.length)) {
    const next = queues[i % queues.length].shift();
    i++;
    if (!next) continue;
    const key = next.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

/** Pull a fresh spread of hot/trending questions from every upstream. */
async function poolFresh(): Promise<Suggestion[]> {
  const settled = await Promise.allSettled([...SE_SITES.map(fromStackExchange), fromHackerNews()]);
  const groups = settled
    .filter((r): r is PromiseFulfilledResult<Suggestion[]> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((g) => g.length);
  return pickSpread(groups, 4);
}

export async function GET(req: NextRequest) {
  // Coarse per-IP backstop: this is an unauthenticated, outbound-fanning route.
  const rl = rateLimit(`suggestions:ip:${clientIp(req)}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { suggestions: [], source: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  const now = Date.now();
  if (now >= nextRefreshAt) {
    try {
      // Coalesce concurrent refreshes so a burst of empty-chat views triggers
      // one upstream sweep, not one per request.
      const job = (inflight ??= poolFresh());
      const picked = await job;
      if (picked.length) {
        pool = picked;
        nextRefreshAt = now + REFRESH_MS; // good pool: hold it for an hour
      } else {
        nextRefreshAt = now + RETRY_MS; // empty: keep last good, retry soon
      }
    } catch {
      nextRefreshAt = now + RETRY_MS; // unreachable: keep last good, retry soon
    } finally {
      inflight = null;
    }
  }
  // Always hot/trending - never generic. Empty only on a cold start with every
  // upstream down; the client then keeps its own locally-cached questions.
  return NextResponse.json(
    pool.length ? { suggestions: pool, source: "live" } : { suggestions: [], source: "empty" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
