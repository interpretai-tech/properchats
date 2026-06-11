import { expect, test } from "@playwright/test";
import {
  isToolConfigured,
  manifestToToolDefs,
  runToolDef,
} from "../src/lib/tools/defs";
import {
  MAX_POST_CHANNELS,
  MAX_POST_CHARS,
  MIN_SCHEDULE_LEAD_MS,
  SCHEDULE_ONLY_COPY,
  SCHEDULE_SKEW_PAD_MS,
  TZ_REQUIRED_COPY,
} from "../src/lib/tools/bindings/postiz";
import {
  byokToolHourlyLimit,
  getToolCallCounts,
  getToolManifest,
} from "../src/lib/tools/registry";

// The one-seam BYOK budget (registry.ts) now meters EVERY social_post
// dispatch in this file against the category:"social" hourly ceiling
// (default 15/h, process-local). This spec makes far more than 15 dispatches
// per worker, so raise the env-tunable limit for the whole file; the budget
// behavior itself is pinned by the dedicated tests below, which lower it
// back down briefly.
process.env.TOOLS_SOCIAL_TOOL_LIMIT = "100000";

/**
 * Postiz social_post binding — shape tests against *recorded* vendor response
 * shapes (CONTRIBUTING_TOOLS.md §3; no live calls, no real keys), plus the
 * bridge discovery/refusal specs. This is the catalog's first tool with
 * PUBLIC SIDE EFFECTS, so the specs here also pin the safety policy:
 * schedule-only (scheduleAt ≥ 10 min out, never type:"now") and the
 * server-derived settings.__type (never trusted from model input).
 *
 * Protocol pins (a dead key must never mask drift):
 *   GET  https://api.postiz.com/public/v1/integrations   Authorization: <key>
 *   POST https://api.postiz.com/public/v1/posts          Authorization: <key>
 * Auth header carries the RAW key — no "Bearer " prefix (docs.postiz.com).
 *
 * FIXTURE PROVENANCE: the recorded shapes below are derived from the public
 * docs' examples (docs.postiz.com/public-api/integrations/list.md and
 * /posts/create.md, fetched 2026-06-11) — we hold no Postiz key, so
 * verification against live-recorded fixtures is a deploy-time TODO.
 */

// ── Recorded Postiz public/v1 response shapes (docs-derived) ────────────────

/** GET /public/v1/integrations — docs example shape, two channels. */
const RECORDED_INTEGRATIONS = [
  {
    id: "cm4ean69r0003w8w1cdomox9n",
    name: "Nevo David",
    identifier: "x",
    picture: "https://uploads.postiz.com/avatar.jpg",
    disabled: false,
    profile: "nevodavid",
    customer: { id: "customer-id", name: "My Company" },
  },
  {
    id: "cm4ean69r0004w8w1cdomoxAB",
    name: "ProperChats",
    identifier: "linkedin",
    picture: "https://uploads.postiz.com/avatar2.jpg",
    disabled: false,
    profile: "properchats",
    customer: { id: "customer-id", name: "My Company" },
  },
];

/** POST /public/v1/posts — docs example success shape. */
const RECORDED_CREATE = [
  { postId: "post-123", integration: "cm4ean69r0003w8w1cdomox9n" },
];

const FAKE_KEY = "pz-test-not-a-real-key";
const CHANNEL_X = "cm4ean69r0003w8w1cdomox9n";
const CHANNEL_LI = "cm4ean69r0004w8w1cdomoxAB";

/** A scheduleAt comfortably past the 10-minute review window. */
function futureIso(msFromNow = MIN_SCHEDULE_LEAD_MS + 60 * 60_000): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

const realFetch = globalThis.fetch;
const realKey = process.env.POSTIZ_API_KEY;

test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.POSTIZ_API_KEY;
  else process.env.POSTIZ_API_KEY = realKey;
});

interface SeenRequest {
  url: string;
  method?: string;
  auth?: string;
  payload?: Record<string, unknown>;
}

/** Install a fetch stub that routes /integrations and /posts to the recorded
 *  shapes (overridable) and records every request. */
function stubPostiz(
  overrides: { integrations?: BodyInit; integrationsStatus?: number; posts?: BodyInit; postsStatus?: number } = {},
): SeenRequest[] {
  const seen: SeenRequest[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url: String(url),
      method: init?.method,
      auth: headers["Authorization"],
      payload: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    if (String(url).includes("/integrations")) {
      return new Response(
        overrides.integrations ?? JSON.stringify(RECORDED_INTEGRATIONS),
        { status: overrides.integrationsStatus ?? 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(overrides.posts ?? JSON.stringify(RECORDED_CREATE), {
      status: overrides.postsStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return seen;
}

// ── Union degradation: no key ⇒ strip, never error ──────────────────────────

test("social_post without POSTIZ_API_KEY is STRIPPED from the defs, not errored", () => {
  delete process.env.POSTIZ_API_KEY;
  expect(isToolConfigured(getToolManifest("social_post")!)).toBe(false);
  const names = manifestToToolDefs().map((d) => d.name);
  expect(names).not.toContain("social_post__list_channels");
  expect(names).not.toContain("social_post__create_post");
  // The rest of the union keeps working.
  expect(names).toContain("weather__get_weather");
});

test("no-key forced dispatch returns normalized error data, never throws", async () => {
  delete process.env.POSTIZ_API_KEY;
  const result = (await runToolDef("social_post__list_channels", {})) as { error?: string };
  expect(result.error).toContain("not configured");
});

test("no-key forced create_post dispatch → normalized { error }, ZERO fetches", async () => {
  delete process.env.POSTIZ_API_KEY;
  const seen = stubPostiz();
  const result = (await runToolDef("social_post__create_post", {
    text: "hi",
    channelIds: [CHANNEL_X],
    scheduleAt: futureIso(),
  })) as { error?: string };
  expect(result.error).toContain("not configured");
  expect(seen).toHaveLength(0); // the 503 fires before any vendor call
});

// ── list_channels shape ──────────────────────────────────────────────────────

test("list_channels shape: pinned GET endpoint, raw-key auth header, trimmed rows", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  expect(manifestToToolDefs().map((d) => d.name)).toContain("social_post__list_channels");

  const seen = stubPostiz();
  const result = (await runToolDef("social_post__list_channels", {})) as {
    channels: { id: string; platform: string; name: string }[];
    truncated: boolean;
  };

  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe("https://api.postiz.com/public/v1/integrations");
  expect(seen[0].method).toBe("GET");
  // Verified from the docs: the key goes in Authorization AS-IS, no Bearer.
  expect(seen[0].auth).toBe(FAKE_KEY);

  expect(result.truncated).toBe(false);
  expect(result.channels).toEqual([
    { id: CHANNEL_X, platform: "x", name: "Nevo David" },
    { id: CHANNEL_LI, platform: "linkedin", name: "ProperChats" },
  ]);
  // Trimmed means trimmed: vendor extras never reach the model.
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("picture");
  expect(serialized).not.toContain("customer");
});

test("list_channels caps at 50 rows and reports truncation", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `cm4ean69r${String(i).padStart(4, "0")}w8w1cdomox`,
    name: `Account ${i}`,
    identifier: "x",
  }));
  stubPostiz({ integrations: JSON.stringify(many) });
  const result = (await runToolDef("social_post__list_channels", {})) as {
    channels: unknown[];
    truncated: boolean;
  };
  expect(result.channels).toHaveLength(50);
  expect(result.truncated).toBe(true);
});

// ── create_post happy path ───────────────────────────────────────────────────

test("create_post shape: integrations lookup then pinned POST /posts with type:schedule", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  const seen = stubPostiz();
  const before = getToolCallCounts().social_post ?? 0;
  const scheduleAt = futureIso();

  const result = (await runToolDef("social_post__create_post", {
    text: "Hello from ProperChats.",
    channelIds: [CHANNEL_X],
    scheduleAt,
  })) as Record<string, unknown>;

  // Two requests: a fresh integrations lookup, then the create.
  expect(seen).toHaveLength(2);
  expect(seen[0].url).toBe("https://api.postiz.com/public/v1/integrations");
  expect(seen[1].url).toBe("https://api.postiz.com/public/v1/posts");
  expect(seen[1].method).toBe("POST");
  expect(seen[1].auth).toBe(FAKE_KEY);

  // SCHEDULE-ONLY: the wire body is type:"schedule" with the normalized date —
  // never type:"now".
  const body = seen[1].payload!;
  expect(body.type).toBe("schedule");
  expect(body.date).toBe(new Date(scheduleAt).toISOString());
  const posts = body.posts as {
    integration: { id: string };
    value: { content: string; image: unknown[] }[];
    settings: { __type: string };
  }[];
  expect(posts).toHaveLength(1);
  expect(posts[0].integration.id).toBe(CHANNEL_X);
  expect(posts[0].value[0].content).toBe("Hello from ProperChats.");
  // __type derived server-side from the integration record ("x").
  expect(posts[0].settings).toEqual({ __type: "x" });

  // Model-visible result: compact {status, scheduledFor, posts}.
  expect(result.status).toBe("scheduled");
  expect(result.scheduledFor).toBe(new Date(scheduleAt).toISOString());
  expect(result.posts).toEqual([{ postId: "post-123", channelId: CHANNEL_X }]);
  expect(JSON.stringify(result).length).toBeLessThan(500);

  // One-seam metering: the dispatch incremented the per-tool counter.
  expect(getToolCallCounts().social_post).toBe(before + 1);
});

test("__type comes from the integrations lookup — a model-supplied platform string is IGNORED", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  const seen = stubPostiz();
  await runToolDef("social_post__create_post", {
    text: "hi",
    channelIds: [CHANNEL_LI],
    scheduleAt: futureIso(),
    // A hostile/hallucinating model trying to steer the platform settings:
    platform: "totally-fake-platform",
    __type: "reddit",
  });
  const posts = (seen[1].payload!.posts as { settings: { __type: string } }[]);
  // linkedin — from the vendor's record for CHANNEL_LI, not the model's args.
  expect(posts[0].settings).toEqual({ __type: "linkedin" });
  expect(JSON.stringify(seen[1].payload)).not.toContain("totally-fake-platform");
  expect(JSON.stringify(seen[1].payload)).not.toContain("reddit");
});

// ── HARD SAFETY: schedule-only enforcement, zero fetches on refusal ─────────

for (const [label, scheduleAt] of [
  ["missing", undefined],
  ["not a datetime", "next tuesday-ish"],
  ["9 minutes out (inside the review window)", new Date(Date.now() + 9 * 60_000).toISOString()],
  [
    "10m30s out (past the lead but inside the 60s clock-skew pad)",
    new Date(Date.now() + MIN_SCHEDULE_LEAD_MS + SCHEDULE_SKEW_PAD_MS / 2).toISOString(),
  ],
  ["in the past", "2020-01-01T00:00:00.000Z"],
  ["over a year out", new Date(Date.now() + 400 * 24 * 60 * 60_000).toISOString()],
] as const) {
  test(`schedule-only: scheduleAt ${label} → ToolError, ZERO fetches`, async () => {
    process.env.POSTIZ_API_KEY = FAKE_KEY;
    const seen = stubPostiz();
    const result = (await runToolDef("social_post__create_post", {
      text: "hi",
      channelIds: [CHANNEL_X],
      ...(scheduleAt !== undefined ? { scheduleAt } : {}),
    })) as { error?: string };
    expect(result.error).toBe(SCHEDULE_ONLY_COPY);
    // Instructive copy: the agent learns the policy and what to tell the user.
    expect(result.error).toContain("10 minutes");
    expect(result.error).toContain("cancelled in Postiz");
    expect(seen).toHaveLength(0);
  });
}

test("a model-supplied type:\"now\" is IGNORED — the wire body is still type:\"schedule\"", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  const seen = stubPostiz();
  const result = (await runToolDef("social_post__create_post", {
    text: "hi",
    channelIds: [CHANNEL_X],
    scheduleAt: futureIso(),
    // A hostile/hallucinating model trying to force immediate publication:
    type: "now",
  })) as Record<string, unknown>;
  expect(result.status).toBe("scheduled");
  expect(seen[1].payload!.type).toBe("schedule");
  expect(JSON.stringify(seen[1].payload)).not.toContain('"now"');
});

// ── TZ required: a timezone-less scheduleAt is ambiguous, refuse it ─────────

for (const [label, scheduleAt] of [
  ["no Z and no offset", futureIso().replace(/Z$/, "")],
  ["date-only", "2099-06-12"],
  ["space-separated, offsetless", "2099-06-12 18:00:00"],
] as const) {
  test(`TZ-less scheduleAt (${label}) → instructive refusal, ZERO fetches`, async () => {
    process.env.POSTIZ_API_KEY = FAKE_KEY;
    const seen = stubPostiz();
    const result = (await runToolDef("social_post__create_post", {
      text: "hi",
      channelIds: [CHANNEL_X],
      scheduleAt,
    })) as { error?: string };
    expect(result.error).toBe(TZ_REQUIRED_COPY);
    expect(result.error).toContain("2026-06-12T18:00:00Z"); // instructive example
    expect(seen).toHaveLength(0);
  });
}

test("an explicit ±HH:MM offset (non-Z) is accepted", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  const seen = stubPostiz();
  const offsetIso = futureIso().replace(/\.\d{3}Z$/, "+00:00");
  const result = (await runToolDef("social_post__create_post", {
    text: "hi",
    channelIds: [CHANNEL_X],
    scheduleAt: offsetIso,
  })) as Record<string, unknown>;
  expect(result.status).toBe("scheduled");
  expect(seen).toHaveLength(2);
});

// ── Disabled channels: never listed, never postable ─────────────────────────

const DISABLED_ROW = {
  id: "cm4ean69r0005w8w1cdomoxCD",
  name: "Suspended Account",
  identifier: "instagram",
  disabled: true,
};

test("a disabled integration is absent from list_channels", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  stubPostiz({ integrations: JSON.stringify([...RECORDED_INTEGRATIONS, DISABLED_ROW]) });
  const result = (await runToolDef("social_post__list_channels", {})) as {
    channels: { id: string }[];
    truncated: boolean;
  };
  expect(result.channels.map((c) => c.id)).toEqual([CHANNEL_X, CHANNEL_LI]);
  expect(JSON.stringify(result)).not.toContain("Suspended Account");
});

test("a disabled integration is unpostable — create_post refuses its id after the lookup", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  const seen = stubPostiz({
    integrations: JSON.stringify([...RECORDED_INTEGRATIONS, DISABLED_ROW]),
  });
  const result = (await runToolDef("social_post__create_post", {
    text: "hi",
    channelIds: [DISABLED_ROW.id],
    scheduleAt: futureIso(),
  })) as { error?: string };
  expect(result.error).toContain("never invent channel ids");
  // Only the integrations lookup happened — no POST /posts.
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toContain("/integrations");
});

// ── One-seam hourly budget (category:"social", default 15/h) ────────────────

test("social_post gets the tighter social-category default (15/h vs 60/h BYOK)", () => {
  const saved = process.env.TOOLS_SOCIAL_TOOL_LIMIT;
  delete process.env.TOOLS_SOCIAL_TOOL_LIMIT;
  try {
    expect(byokToolHourlyLimit(getToolManifest("social_post")!)).toBe(15);
    expect(byokToolHourlyLimit(getToolManifest("tts")!)).toBe(60);
  } finally {
    process.env.TOOLS_SOCIAL_TOOL_LIMIT = saved;
  }
});

test("budget exhausted at the invokeTool seam → normalized { error }, ZERO fetches", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  const savedLimit = process.env.TOOLS_SOCIAL_TOOL_LIMIT;
  process.env.TOOLS_SOCIAL_TOOL_LIMIT = "1";
  try {
    const seen = stubPostiz();
    // Whatever this worker consumed before, one more call saturates limit=1…
    await runToolDef("social_post__list_channels", {});
    const fetchesSoFar = seen.length;
    // …so THIS dispatch must be refused by the budget, before any fetch.
    const refused = (await runToolDef("social_post__list_channels", {})) as { error?: string };
    expect(refused.error).toContain("hourly budget");
    expect(seen.length).toBe(fetchesSoFar); // the refusal cost zero vendor calls
  } finally {
    process.env.TOOLS_SOCIAL_TOOL_LIMIT = savedLimit;
  }
});

// ── channelIds / text validation, zero fetches on refusal ───────────────────

for (const [label, channelIds] of [
  ["empty", []],
  ["more than 5", Array.from({ length: MAX_POST_CHANNELS + 1 }, () => CHANNEL_X)],
  ["not an array", "cm4ean69r0003w8w1cdomox9n"],
] as const) {
  test(`create_post refuses channelIds ${label} before any fetch`, async () => {
    process.env.POSTIZ_API_KEY = FAKE_KEY;
    const seen = stubPostiz();
    const result = (await runToolDef("social_post__create_post", {
      text: "hi",
      channelIds,
      scheduleAt: futureIso(),
    })) as { error?: string };
    expect(result.error).toContain("channelIds");
    expect(seen).toHaveLength(0);
  });
}

test("create_post refuses junk channel-id charsets before any fetch", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  const seen = stubPostiz();
  const result = (await runToolDef("social_post__create_post", {
    text: "hi",
    channelIds: ["../public/v1/admin"],
    scheduleAt: futureIso(),
  })) as { error?: string };
  expect(result.error).toContain("list_channels");
  expect(seen).toHaveLength(0);
});

test("create_post refuses empty and oversize text before any fetch", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  const seen = stubPostiz();
  const empty = (await runToolDef("social_post__create_post", {
    text: "   ",
    channelIds: [CHANNEL_X],
    scheduleAt: futureIso(),
  })) as { error?: string };
  expect(empty.error).toContain("text");

  const oversize = (await runToolDef("social_post__create_post", {
    text: "a".repeat(MAX_POST_CHARS + 1),
    channelIds: [CHANNEL_X],
    scheduleAt: futureIso(),
  })) as { error?: string };
  expect(oversize.error).toContain("too long");
  expect(seen).toHaveLength(0);
});

test("an unknown (but well-formed) channel id is refused after the lookup, before the create", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  const seen = stubPostiz();
  const result = (await runToolDef("social_post__create_post", {
    text: "hi",
    channelIds: ["cm4ean69rZZZZw8w1cdomoxZZ"],
    scheduleAt: futureIso(),
  })) as { error?: string };
  expect(result.error).toContain("never invent channel ids");
  // Only the integrations lookup happened — no POST /posts.
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toContain("/integrations");
});

// ── Normalizer owns the copy ────────────────────────────────────────────────

test("vendor 500 on create comes back as OUR copy, never vendor prose", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  stubPostiz({
    posts: JSON.stringify({ message: "PrismaClientKnownRequestError at posts.service.ts:42" }),
    postsStatus: 500,
  });
  const result = (await runToolDef("social_post__create_post", {
    text: "hi",
    channelIds: [CHANNEL_X],
    scheduleAt: futureIso(),
  })) as { error?: string };
  expect(result.error).toBe("Postiz responded 500");
  expect(JSON.stringify(result)).not.toContain("Prisma");
});

test("vendor 400 on create (richer platform settings) → normalized per-platform copy, vendor field names redacted", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  stubPostiz({
    posts: JSON.stringify({
      message: ["settings.subreddit must be an array", "settings.title should not be empty"],
    }),
    postsStatus: 400,
  });
  const result = (await runToolDef("social_post__create_post", {
    text: "hi",
    channelIds: [CHANNEL_X],
    scheduleAt: futureIso(),
  })) as { error?: string };
  expect(result.error).toBe(
    "Postiz rejected the post settings for x — this platform may need options the binding doesn't support yet",
  );
  expect(JSON.stringify(result)).not.toContain("subreddit");
});

test("vendor 502 on the channel list is normalized too", async () => {
  process.env.POSTIZ_API_KEY = FAKE_KEY;
  stubPostiz({ integrations: "upstream exploded", integrationsStatus: 502 });
  const result = (await runToolDef("social_post__list_channels", {})) as { error?: string };
  expect(result.error).toBe("Postiz responded 502");
});

// ── Bridge route: discovery + unconfigured refusal (live server) ────────────

test("social_post discovery: GET /api/tools/social_post returns the manifest, BYOK, secret-free", async ({
  request,
}) => {
  const res = await request.get("/api/tools/social_post");
  expect(res.ok()).toBeTruthy();
  const manifest = await res.json();
  expect(manifest.id).toBe("social_post");
  expect(manifest.pricing).toBe("byok");
  expect(manifest.category).toBe("social");
  expect(manifest.maintainer).toBeTruthy();
  expect(manifest.auth.secrets).toEqual(["POSTIZ_API_KEY"]);
  // Shared-authority declaration: deployer-scoped key, all users share the
  // connected accounts (requiresSignIn is declarative — see manifest.ts).
  expect(manifest.auth.requiresSignIn).toBe(true);
  expect(manifest.display.hint).toContain("SHARED AUTHORITY");
  expect(manifest.description).toContain("all users of this deployment share");
  expect(manifest.upstream.license).toBe("AGPL-3.0");
  expect(manifest.binding.functions.map((f: { name: string }) => f.name)).toEqual([
    "list_channels",
    "create_post",
  ]);
  // The prompt text carries the schedule-only policy.
  expect(manifest.description).toContain("never claim a post was published immediately");
  // The discovery payload must never leak the key's value.
  expect(JSON.stringify(manifest)).not.toContain(
    process.env.POSTIZ_API_KEY ?? " no-key-on-this-host ",
  );
});

test("social_post bridge: unconfigured server refuses with 503", async ({ request }) => {
  test.skip(!!process.env.POSTIZ_API_KEY, "server has a key; live behavior is vendor-billed");
  const res = await request.post("/api/tools/social_post", {
    data: { function: "list_channels", args: {} },
  });
  expect(res.status()).toBe(503);
  const body = await res.json();
  expect(body.error).toContain("not configured");
});
