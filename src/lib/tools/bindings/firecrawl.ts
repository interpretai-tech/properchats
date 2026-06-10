/**
 * Web-scrape binding — proxies Firecrawl (https://github.com/firecrawl/firecrawl,
 * AGPL-3.0), the open-source scrape/crawl/search service that returns
 * LLM-ready markdown. First BYOK tool in the registry: the server needs
 * FIRECRAWL_API_KEY (cloud key, or any value your self-hosted instance
 * accepts); point FIRECRAWL_BASE_URL at a self-hosted deployment to leave
 * the cloud entirely.
 */
import { ToolError } from "../manifest";

const FIRECRAWL_BASE =
  process.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev";
const FETCH_TIMEOUT_MS = 30_000;
/** Agent-sized output: pages are trimmed, never streamed whole into a turn. */
const MAX_MARKDOWN_CHARS = 8_000;
const MAX_SEARCH_LIMIT = 5;

function apiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    throw new ToolError(
      "Web scrape is not configured on this server (FIRECRAWL_API_KEY is unset)",
      503,
    );
  }
  return key;
}

async function firecrawl(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = apiKey(); // resolve before the try: its 503 must not become a 502
  let res: Response;
  try {
    res = await fetch(`${FIRECRAWL_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ToolError("Firecrawl request failed or timed out", 502);
  }
  if (!res.ok) {
    throw new ToolError(`Firecrawl responded ${res.status}`, 502);
  }
  return (await res.json()) as Record<string, unknown>;
}

export interface ScrapeResult {
  url: string;
  title?: string;
  markdown: string;
  /** True when the page exceeded the agent-sized cap and was cut. */
  truncated: boolean;
}

export async function scrapeUrl(args: Record<string, unknown>): Promise<ScrapeResult> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) {
    throw new ToolError("`url` must be an http(s) URL", 400);
  }
  const onlyMain = args.only_main_content !== false;
  const body = await firecrawl("/v2/scrape", {
    url,
    formats: ["markdown"],
    onlyMainContent: onlyMain,
  });
  const data = (body.data ?? body) as Record<string, unknown>;
  const markdown = typeof data.markdown === "string" ? data.markdown : "";
  if (!markdown) throw new ToolError("Firecrawl returned no markdown for this page", 502);
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  return {
    url,
    title: typeof metadata.title === "string" ? metadata.title : undefined,
    markdown: markdown.slice(0, MAX_MARKDOWN_CHARS),
    truncated: markdown.length > MAX_MARKDOWN_CHARS,
  };
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(args: Record<string, unknown>): Promise<{ query: string; results: SearchHit[] }> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new ToolError("`query` is required", 400);
  const limit = Math.min(
    Math.max(1, Number(args.limit) || MAX_SEARCH_LIMIT),
    MAX_SEARCH_LIMIT,
  );
  const body = await firecrawl("/v2/search", { query, limit });
  const data = body.data as Record<string, unknown> | unknown[] | undefined;
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>)?.web)
      ? ((data as Record<string, unknown>).web as unknown[])
      : [];
  const results: SearchHit[] = rows.slice(0, limit).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      title: typeof row.title === "string" ? row.title : "",
      url: typeof row.url === "string" ? row.url : "",
      snippet: typeof row.description === "string" ? row.description : "",
    };
  });
  return { query, results };
}
