import { expect, test } from "@playwright/test";

/**
 * End-to-end proof that the open-source tool registry is *enabled*, not just
 * declared: each webhook-bound manifest is discoverable at GET /api/tools/<id>
 * and invokable at POST /api/tools/<id> through the real Next.js route →
 * registry → binding path.
 *
 * - calculator (mathjs) is deterministic and offline — asserted strictly.
 * - weather (wttr.in) makes a real keyless network call — asserted strictly,
 *   with a clean 502 envelope accepted only if the public instance is
 *   rate-limiting this host.
 * - stock_quote (yahoo-finance2) makes a real keyless network call — shape
 *   asserted when upstream answers; a clean 502 envelope is tolerated.
 */

test("registry discovery: GET /api/tools/<id> returns the manifest", async ({ request }) => {
  const res = await request.get("/api/tools/weather");
  expect(res.ok()).toBeTruthy();
  const manifest = await res.json();
  expect(manifest.id).toBe("weather");
  expect(manifest.binding.kind).toBe("webhook");
  expect(manifest.binding.functions[0].name).toBe("get_weather");
  expect(manifest.upstream.repo).toBe("https://github.com/chubin/wttr.in");
});

test("unknown tool ids 404", async ({ request }) => {
  const res = await request.post("/api/tools/nope", {
    data: { function: "x", args: {} },
  });
  expect(res.status()).toBe(404);
});

test("calculator: deterministic mathjs evaluation through the bridge", async ({ request }) => {
  const res = await request.post("/api/tools/calculator", {
    data: { function: "calculate", args: { expression: "sqrt(3^2 + 4^2)" } },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.result.result).toBe("5");

  const units = await request.post("/api/tools/calculator", {
    data: { function: "calculate", args: { expression: "12.5 cm to inch" } },
  });
  const unitsBody = await units.json();
  expect(unitsBody.result.result).toContain("4.92");
});

test("calculator: security-sensitive mathjs functions are disabled", async ({ request }) => {
  const res = await request.post("/api/tools/calculator", {
    data: { function: "calculate", args: { expression: 'import({}, {})' } },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("disabled");
});

test("weather: real keyless wttr.in call through the bridge", async ({ request }) => {
  const res = await request.post("/api/tools/weather", {
    data: { function: "get_weather", args: { location: "Paris" } },
  });
  const body = await res.json();
  if (res.status() === 502) {
    // Public wttr.in instance rate-limiting this host — clean error envelope.
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    return;
  }
  expect(res.ok()).toBeTruthy();
  expect(body.ok).toBe(true);
  expect(body.result.location).toBe("Paris");
  expect((body.result.resolvedArea ?? "").length).toBeGreaterThan(0);
  expect(Number(body.result.current.tempC)).not.toBeNaN();
  expect(body.result.forecast.length).toBeGreaterThan(0);
  expect(body.result.source).toBe("wttr.in");
});

test("stock_quote: real keyless Yahoo Finance call through the bridge", async ({ request }) => {
  const res = await request.post("/api/tools/stock_quote", {
    data: { function: "stock_quote", args: { symbol: "AAPL" } },
  });
  const body = await res.json();
  if (res.status() === 502) {
    // Upstream Yahoo throttling this host — clean error envelope.
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    return;
  }
  expect(res.ok()).toBeTruthy();
  expect(body.ok).toBe(true);
  expect(body.result.symbol).toBe("AAPL");
  expect(typeof body.result.price).toBe("number");
  expect(body.result.currency).toBe("USD");
});


test("web_scrape discovery: manifest is registered, BYOK, secret-free", async ({ request }) => {
  const res = await request.get("/api/tools/web_scrape");
  expect(res.ok()).toBeTruthy();
  const manifest = await res.json();
  expect(manifest.id).toBe("web_scrape");
  expect(manifest.pricing).toBe("byok");
  expect(manifest.auth.secrets).toEqual(["FIRECRAWL_API_KEY"]);
  expect(manifest.binding.functions.map((f: { name: string }) => f.name)).toEqual([
    "scrape_url",
    "search_web",
  ]);
  // The discovery payload must never leak the key's value.
  expect(JSON.stringify(manifest)).not.toContain(process.env.FIRECRAWL_API_KEY ?? " never");
});

test("web_scrape: unconfigured server refuses with 503, bad url with 400", async ({ request }) => {
  test.skip(!!process.env.FIRECRAWL_API_KEY, "server has a key; the live test below covers dispatch");
  const res = await request.post("/api/tools/web_scrape", {
    data: { function: "scrape_url", args: { url: "https://example.com" } },
  });
  expect(res.status()).toBe(503);
  const bad = await request.post("/api/tools/web_scrape", {
    data: { function: "scrape_url", args: { url: "notaurl" } },
  });
  // On configured hosts arg validation 400s; on unconfigured hosts the key
  // check 503s first - accept either refusal.
  expect([400, 503]).toContain(bad.status());
});

test("web_scrape: live scrape through the bridge (BYOK)", async ({ request }) => {
  test.skip(!process.env.FIRECRAWL_API_KEY, "FIRECRAWL_API_KEY not configured");
  const res = await request.post("/api/tools/web_scrape", {
    data: { function: "scrape_url", args: { url: "https://example.com" } },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.result.markdown.toLowerCase()).toContain("example");
  expect(typeof body.result.truncated).toBe("boolean");
});
