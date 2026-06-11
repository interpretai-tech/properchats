import { expect, test } from "@playwright/test";
import type { NextRequest } from "next/server";
import { POST } from "../src/app/api/tools/[tool]/route";

/**
 * Bridge abuse posture (POST /api/tools/<id>), pinned by driving the route
 * handler directly — no live vendor calls, no real keys:
 *
 * - Content-Type must be application/json → 415 otherwise. This alone kills
 *   no-preflight CSRF: a cross-origin "simple request" can only be
 *   text/plain / form-encoded.
 * - Browser provenance headers indicating another site (Sec-Fetch-Site:
 *   cross-site, or a mismatched Origin) → 403. ABSENT headers = programmatic
 *   caller, allowed by design (the bridge is a public API).
 * - BYOK-metered tools (manifest auth.secrets) carry a per-tool hourly budget
 *   on top of the per-IP burst limit → 429 once exhausted, regardless of IP.
 *
 * The budget tests use the tts tool with ELEVENLABS_API_KEY removed: each
 * accepted call fails fast with the binding's 503 (never a network call) but
 * still consumes the per-tool budget, which is deliberately charged BEFORE
 * dispatch.
 */

const realKey = process.env.ELEVENLABS_API_KEY;
test.afterEach(() => {
  if (realKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = realKey;
});

function post(
  tool: string,
  opts: { headers?: Record<string, string>; body?: string; contentType?: string | null } = {},
): Promise<Response> {
  const headers = new Headers(opts.headers ?? {});
  const ct = opts.contentType === undefined ? "application/json" : opts.contentType;
  if (ct !== null) headers.set("content-type", ct);
  const req = new Request(`http://localhost:3000/api/tools/${tool}`, {
    method: "POST",
    headers,
    body: opts.body ?? JSON.stringify({ function: "calculate", args: { expression: "1+1" } }),
  });
  return POST(req as unknown as NextRequest, { params: Promise.resolve({ tool }) });
}

test("non-JSON Content-Type is refused with 415 (kills no-preflight CSRF)", async () => {
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
    const res = await post("calculator", { contentType });
    expect(res.status).toBe(415);
  }
  // JSON with parameters still passes the gate (keyless tool runs normally).
  const ok = await post("calculator", { contentType: "application/json; charset=utf-8" });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { result: { result: string } }).result.result).toBe("2");
});

test("cross-site browser callers are refused with 403; same-origin and headerless pass", async () => {
  // Sec-Fetch-Site says another site → 403 (even with a matching Origin).
  const sfs = await post("calculator", { headers: { "sec-fetch-site": "cross-site" } });
  expect(sfs.status).toBe(403);

  // Origin host differs from the request Host → 403; "null" Origin → 403.
  const xo = await post("calculator", {
    headers: { host: "localhost:3000", origin: "https://evil.example" },
  });
  expect(xo.status).toBe(403);
  const nullOrigin = await post("calculator", {
    headers: { host: "localhost:3000", origin: "null" },
  });
  expect(nullOrigin.status).toBe(403);

  // Same-origin browser call passes.
  const same = await post("calculator", {
    headers: {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      "sec-fetch-site": "same-origin",
    },
  });
  expect(same.status).toBe(200);

  // No provenance headers at all = programmatic caller, allowed by design.
  const programmatic = await post("calculator");
  expect(programmatic.status).toBe(200);
});

test("BYOK tools (auth.secrets) hit the per-tool hourly budget with 429, across IPs", async () => {
  delete process.env.ELEVENLABS_API_KEY; // every accepted call 503s offline
  const limit = Number(process.env.TOOLS_BYOK_TOOL_LIMIT) || 60;
  const body = JSON.stringify({ function: "text_to_speech", args: { text: "hi" } });

  let budget429 = 0;
  for (let i = 0; i < limit + 3; i++) {
    // Distinct IPs: the per-IP burst limit must not be what trips first —
    // the per-tool budget is shared across all callers.
    const res = await post("tts", {
      body,
      headers: { "x-forwarded-for": `203.0.113.${i % 250}` },
    });
    if (i < limit) {
      expect(res.status).toBe(503); // accepted by the gates, binding unconfigured
    } else {
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBeTruthy();
      expect(((await res.json()) as { error: string }).error).toContain("budget");
      budget429++;
    }
  }
  expect(budget429).toBe(3);

  // Keyless tools are untouched by the exhausted BYOK budget.
  const keyless = await post("calculator", {
    headers: { "x-forwarded-for": "203.0.113.251" },
  });
  expect(keyless.status).toBe(200);
});
