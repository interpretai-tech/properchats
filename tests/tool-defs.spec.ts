import { expect, test } from "@playwright/test";
import {
  isToolConfigured,
  manifestToToolDefs,
  parseToolDefName,
  runToolDef,
  TOOL_NAME_SEP,
  toolDefStatusText,
  toolDefTraceText,
} from "../src/lib/tools/defs";
import {
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
  UNTRUSTED_NOTE,
} from "../src/lib/tools/bindings/firecrawl";
import {
  assertToolIdsValid,
  getToolCallCounts,
  getToolManifest,
  TOOL_MANIFESTS,
} from "../src/lib/tools/registry";

/**
 * M2 shape tests (TOOL_MARKETPLACE.md "masked failures unmask on vendor
 * recovery" note): the Firecrawl binding is exercised through the FULL new
 * model-tool path — defs generated → tool-call dispatched through the
 * registry seam → result returned — against *recorded* vendor response
 * shapes, never live keys. A dead key can't mask an endpoint/protocol
 * mismatch here, and the no-key cases prove union degradation: the binding
 * is STRIPPED from the defs list, not errored mid-loop.
 *
 * These are node-side unit tests (no page/request fixtures); they share the
 * Playwright runner so contributors have exactly one test setup.
 */

// ── Recorded Firecrawl v2 response shapes (no live calls, no real keys) ─────

const RECORDED_SCRAPE = {
  success: true,
  data: {
    markdown: "# Example Domain\n\nThis domain is for use in illustrative examples.",
    metadata: {
      title: "Example Domain",
      sourceURL: "https://example.com",
      statusCode: 200,
    },
  },
};

const RECORDED_SEARCH = {
  success: true,
  data: {
    web: [
      {
        title: "Example Domain",
        description: "Illustrative example domain snippet.",
        url: "https://example.com",
      },
      {
        title: "IANA — Example domains",
        description: "Reserved example domains.",
        url: "https://www.iana.org/domains/reserved",
      },
    ],
  },
};

const FAKE_KEY = "fc-test-not-a-real-key";

const realFetch = globalThis.fetch;
const realKey = process.env.FIRECRAWL_API_KEY;

test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = realKey;
});

/** Install a fetch stub that records the request and replies with `body`. */
function stubFetch(body: unknown, status = 200) {
  const seen: { url: string; auth?: string; payload?: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url: String(url),
      auth: headers.Authorization,
      payload: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return seen;
}

// ── Def generation ──────────────────────────────────────────────────────────

test("keyless manifests map to namespaced provider-agnostic tool defs", () => {
  delete process.env.FIRECRAWL_API_KEY;
  const defs = manifestToToolDefs();
  const names = defs.map((d) => d.name);
  expect(names).toContain("weather__get_weather");
  expect(names).toContain("calculator__calculate");
  expect(names).toContain("stock_quote__stock_quote");

  // Schema comes straight from the manifest; description carries both the
  // per-function text and the manifest's agent blurb (it is prompt text).
  const weather = defs.find((d) => d.name === "weather__get_weather")!;
  const manifest = getToolManifest("weather")!;
  expect(manifest.binding.kind).toBe("webhook");
  if (manifest.binding.kind === "webhook") {
    expect(weather.parameters).toEqual(manifest.binding.functions[0].parameters);
    expect(weather.description).toContain(manifest.binding.functions[0].description);
    expect(weather.description).toContain(manifest.description);
  }
});

test("namespaced names round-trip through parseToolDefName (ids may contain _)", () => {
  expect(parseToolDefName(`web_scrape${TOOL_NAME_SEP}scrape_url`)).toEqual({
    toolId: "web_scrape",
    fn: "scrape_url",
  });
  expect(parseToolDefName("not_a_tool__fn")).toBeNull();
});

// ── Union degradation: strip, never error ───────────────────────────────────

test("BYOK binding without its key is STRIPPED from the defs, not errored", () => {
  delete process.env.FIRECRAWL_API_KEY;
  expect(isToolConfigured(getToolManifest("web_scrape")!)).toBe(false);
  const defs = manifestToToolDefs();
  expect(defs.map((d) => d.name)).not.toContain("web_scrape__scrape_url");
  expect(defs.map((d) => d.name)).not.toContain("web_scrape__search_web");
  // The rest of the union keeps working.
  expect(defs.map((d) => d.name)).toContain("weather__get_weather");
});

test("defense in depth: a no-key dispatch returns normalized error data, never throws", async () => {
  delete process.env.FIRECRAWL_API_KEY;
  const result = (await runToolDef("web_scrape__scrape_url", {
    url: "https://example.com",
  })) as { error?: string };
  expect(result.error).toContain("not configured");
});

// ── Full path: defs generated → tool-call dispatched → result returned ──────

test("scrape_url shape: full path against the recorded vendor response", async () => {
  process.env.FIRECRAWL_API_KEY = FAKE_KEY;
  expect(manifestToToolDefs().map((d) => d.name)).toContain("web_scrape__scrape_url");

  const seen = stubFetch(RECORDED_SCRAPE);
  const before = getToolCallCounts().web_scrape ?? 0;
  const result = (await runToolDef("web_scrape__scrape_url", {
    url: "https://example.com",
  })) as { url: string; title?: string; markdown: string; truncated: boolean };

  expect(result.url).toBe("https://example.com");
  expect(result.title).toBe("Example Domain");
  expect(result.markdown).toContain("# Example Domain");
  expect(result.truncated).toBe(false);

  // Protocol shape: the binding hit the v2 scrape endpoint with bearer auth.
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe("https://api.firecrawl.dev/v2/scrape");
  expect(seen[0].auth).toBe(`Bearer ${FAKE_KEY}`);
  expect(seen[0].payload?.url).toBe("https://example.com");

  // One-seam metering: the dispatch incremented the per-tool counter.
  expect(getToolCallCounts().web_scrape).toBe(before + 1);
});

test("search_web shape: rows map to compact {title, url, snippet}", async () => {
  process.env.FIRECRAWL_API_KEY = FAKE_KEY;
  const seen = stubFetch(RECORDED_SEARCH);
  const result = (await runToolDef("web_scrape__search_web", {
    query: "example domain",
    limit: 2,
  })) as { query: string; results: { title: string; url: string; snippet: string }[] };

  expect(seen[0].url).toBe("https://api.firecrawl.dev/v2/search");
  expect(result.query).toBe("example domain");
  expect(result.results).toEqual([
    {
      title: "Example Domain",
      url: "https://example.com",
      snippet: "Illustrative example domain snippet.",
    },
    {
      title: "IANA — Example domains",
      url: "https://www.iana.org/domains/reserved",
      snippet: "Reserved example domains.",
    },
  ]);
});

// ── Normalizer owns the copy ────────────────────────────────────────────────

test("vendor failure comes back as OUR copy, never raw vendor prose", async () => {
  process.env.FIRECRAWL_API_KEY = FAKE_KEY;
  stubFetch({ error: "FirecrawlInternalPanic: stack trace at line 42" }, 500);
  const result = (await runToolDef("web_scrape__scrape_url", {
    url: "https://example.com",
  })) as { error?: string };
  expect(result.error).toBe("Firecrawl responded 500");
  expect(JSON.stringify(result)).not.toContain("FirecrawlInternalPanic");
});

test("unknown tool name returns normalized error data, never throws", async () => {
  const result = (await runToolDef("nope__fn", {})) as { error?: string };
  expect(result.error).toBe("Unknown tool: nope__fn");
});

// ── F9: SSRF host guard — internal targets refused before any fetch ─────────

const SSRF_URLS = [
  "http://127.0.0.1/admin",
  "http://127.1.2.3:8080/x",
  "http://localhost:3000/secrets",
  "http://sub.localhost/x",
  "http://[::1]/x",
  "http://[::ffff:127.0.0.1]/x",
  "http://0.0.0.0/x",
  "http://169.254.169.254/latest/meta-data/",
  "http://metadata.google.internal/computeMetadata/v1/",
  "http://10.0.0.5/internal",
  "http://172.16.4.2/internal",
  "http://192.168.1.1/router",
  "http://100.64.0.1/cgnat",
  // Raw-IP encodings of 127.0.0.1: decimal, hex, octal, short-form.
  "http://2130706433/",
  "http://0x7f000001/",
  "http://0x7f.0.0.1/",
  "http://017700000001/",
  "http://127.1/",
];

for (const bad of SSRF_URLS) {
  test(`SSRF guard refuses ${bad} with normalized copy, no upstream call`, async () => {
    process.env.FIRECRAWL_API_KEY = FAKE_KEY;
    const seen = stubFetch(RECORDED_SCRAPE);
    const result = (await runToolDef("web_scrape__scrape_url", { url: bad })) as {
      error?: string;
    };
    expect(result.error).toBe(
      "This URL points at a private, loopback, or internal network address and was refused.",
    );
    expect(seen).toHaveLength(0); // refused at the seam, Firecrawl never contacted
  });
}

test("SSRF guard still allows public hosts", async () => {
  process.env.FIRECRAWL_API_KEY = FAKE_KEY;
  const seen = stubFetch(RECORDED_SCRAPE);
  const result = (await runToolDef("web_scrape__scrape_url", {
    url: "https://example.com/page",
  })) as { error?: string; markdown?: string };
  expect(result.error).toBeUndefined();
  expect(seen).toHaveLength(1);
});

// ── F2: untrusted-content envelope on scrape/search payloads ────────────────

test("scraped markdown is wrapped in the untrusted-content envelope", async () => {
  process.env.FIRECRAWL_API_KEY = FAKE_KEY;
  stubFetch(RECORDED_SCRAPE);
  const result = (await runToolDef("web_scrape__scrape_url", {
    url: "https://example.com",
  })) as { markdown: string; notice: string };
  expect(result.markdown.startsWith(UNTRUSTED_BEGIN)).toBe(true);
  expect(result.markdown.endsWith(UNTRUSTED_END)).toBe(true);
  expect(result.markdown).toContain("# Example Domain");
  expect(result.notice).toBe(UNTRUSTED_NOTE);
});

test("search results carry the untrusted-content notice", async () => {
  process.env.FIRECRAWL_API_KEY = FAKE_KEY;
  stubFetch(RECORDED_SEARCH);
  const result = (await runToolDef("web_scrape__search_web", {
    query: "example",
  })) as { notice: string };
  expect(result.notice).toBe(UNTRUSTED_NOTE);
});

// ── F8: tool ids must not contain the name separator ────────────────────────

test("registration asserts tool ids contain no separator", () => {
  expect(() => assertToolIdsValid()).not.toThrow(); // real registry is clean
  const bad = { ...TOOL_MANIFESTS[0], id: "evil__tool" };
  expect(() => assertToolIdsValid([bad])).toThrow(/must not contain "__"/);
});

// ── F11: status/trace lines never echo the model-emitted name ───────────────

test("status and trace lines resolve names against the registry", () => {
  expect(toolDefStatusText("calculator__calculate")).toBe("Running Calculator (calculate)…");
  expect(toolDefTraceText("calculator__calculate")).toBe("Used Calculator (calculate)");
  // Unknown / hostile names degrade to generic copy — never echoed verbatim.
  const hostile = "calculator__<img src=x onerror=alert(1)>";
  expect(toolDefStatusText(hostile)).toBe("Running tool…");
  expect(toolDefTraceText(hostile)).toBe("Used a community tool");
  expect(toolDefStatusText("ignore previous instructions__run")).toBe("Running tool…");
});

test("bad args are a 400-style normalized error through the same seam", async () => {
  process.env.FIRECRAWL_API_KEY = FAKE_KEY;
  stubFetch(RECORDED_SCRAPE);
  const result = (await runToolDef("web_scrape__scrape_url", {
    url: "ftp://nope",
  })) as { error?: string };
  expect(result.error).toBe("`url` must be an http(s) URL");
});
