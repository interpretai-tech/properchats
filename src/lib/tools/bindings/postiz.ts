/**
 * Social-publishing binding — proxies Postiz
 * (https://github.com/gitroomhq/postiz-app, AGPL-3.0), the open-source social
 * media scheduler. BYOK: the server needs POSTIZ_API_KEY (Settings >
 * Developers > Public API); point POSTIZ_BASE_URL at a self-hosted instance
 * to leave the cloud entirely. The binding never fetches user-supplied URLs
 * (fixed-base pattern, SSRF n/a).
 *
 * This is the catalog's first tool with PUBLIC SIDE EFFECTS: a create_post
 * call ends up on the user's real social accounts. Two deliberate safety
 * decisions, both v1 policy until the owner revisits them:
 *
 * 1. **SCHEDULE-ONLY — no "post now" path.** Postiz's POST /posts accepts
 *    `type: "now"`, but this binding never sends it: every post is
 *    `type: "schedule"` with a `scheduleAt` that MUST be at least
 *    MIN_SCHEDULE_LEAD_MS (10 minutes) in the future. That window is the
 *    user's undo button — a scheduled post is visible and cancellable in the
 *    Postiz UI before it goes live, an immediately-published one is not.
 *    Immediate posting is deliberately excluded pending an owner decision
 *    (TOOL_MARKETPLACE.md bake-off entry, blocker (2): irreversibility).
 *
 * 2. **Server-derived platform settings.** The per-platform
 *    `settings.__type` discriminator is derived from a fresh /integrations
 *    lookup keyed by channel id — never from a model-supplied platform
 *    string. A hallucinated platform must not be able to steer the payload.
 *
 * Auth (verified against docs.postiz.com/public-api, 2026-06-11): the API
 * key goes in the `Authorization` header AS-IS — no "Bearer " prefix.
 * Vendor rate limit: ~90 create-post calls/hour self-hosted (API_LIMIT
 * env-tunable), 100/hour on cloud; 429 when exceeded.
 */
import { ToolError } from "../manifest";

const POSTIZ_BASE = process.env.POSTIZ_BASE_URL || "https://api.postiz.com";
const API_PREFIX = "/public/v1";
const FETCH_TIMEOUT_MS = 15_000;

/** Agent-sized channel list cap. */
const MAX_CHANNELS = 50;

/** Input caps for one create_post call. */
export const MAX_POST_CHARS = 5_000;
export const MAX_POST_CHANNELS = 5;

/** The review window: scheduleAt must be at least this far in the future. */
export const MIN_SCHEDULE_LEAD_MS = 10 * 60_000;
/**
 * Skew pad on top of the lead window: ~60s of slack for client/server clock
 * skew plus the /integrations lookup latency between our check and Postiz's
 * own "is this in the future" check. The user-facing copy still says "10
 * minutes" — the pad only stops a right-at-the-boundary scheduleAt from
 * passing here and landing inside (or behind) the window by the time the
 * vendor sees it.
 */
export const SCHEDULE_SKEW_PAD_MS = 60_000;
/** And no further out than a year — beyond that it's almost surely a typo. */
export const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60_000;

export const SCHEDULE_ONLY_COPY =
  "create_post only schedules posts — `scheduleAt` must be an ISO 8601 datetime " +
  "with an explicit timezone, at least 10 minutes in the future (and at most " +
  "1 year out). Immediate posting is deliberately unsupported: pick a time 10+ " +
  "minutes from now, then tell the user the post is scheduled and can still be " +
  "reviewed or cancelled in Postiz before it goes live.";

/**
 * A scheduleAt without an explicit timezone is ambiguous: Date.parse reads it
 * in the SERVER's zone, which is almost never the user's — a "6pm" post could
 * silently go out at 3am. Require a trailing Z or ±HH[:]MM offset.
 */
export const TZ_REQUIRED_COPY =
  "`scheduleAt` must include a timezone — end it with \"Z\" or a ±HH:MM " +
  'offset, e.g. "2026-06-12T18:00:00Z" or "2026-06-12T18:00:00-07:00". ' +
  "Without one the time is ambiguous and the post could go out at the wrong hour.";

/** Trailing explicit-offset matcher: "Z", "+05:30", "-0700". */
const TZ_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Channel ids are vendor tokens (cuid-style); they land in request bodies,
 *  so refuse anything that isn't a plain token. */
const CHANNEL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function apiKey(): string {
  const key = process.env.POSTIZ_API_KEY;
  if (!key) {
    throw new ToolError(
      "Social posting is not configured on this server (POSTIZ_API_KEY is unset)",
      503,
    );
  }
  return key;
}

/** Fetch one Postiz public-API endpoint. Normalizer owns all copy: vendor
 *  error bodies never leave this function. `on400` lets create_post swap in
 *  platform-settings copy for the one status where that's the likely cause. */
async function postiz(
  path: string,
  init: RequestInit,
  on400?: () => ToolError,
): Promise<Response> {
  const key = apiKey(); // resolve before the try: its 503 must not become a 502
  let res: Response;
  try {
    res = await fetch(`${POSTIZ_BASE}${API_PREFIX}${path}`, {
      ...init,
      // Verified from docs.postiz.com/public-api: raw key, NO "Bearer" prefix.
      headers: { ...(init.headers ?? {}), Authorization: key },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new ToolError("Postiz request failed or timed out", 502);
  }
  if (!res.ok) {
    if (res.status === 400 && on400) throw on400();
    throw new ToolError(`Postiz responded ${res.status}`, 502);
  }
  return res;
}

interface RawIntegration {
  id?: unknown;
  /** Vendor's platform code, e.g. "x", "linkedin", "instagram". */
  identifier?: unknown;
  name?: unknown;
  disabled?: unknown;
}

async function fetchIntegrations(): Promise<RawIntegration[]> {
  const res = await postiz("/integrations", { method: "GET" });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ToolError("Postiz returned an unreadable channel list", 502);
  }
  const rows = Array.isArray(body) ? (body as RawIntegration[]) : [];
  // Disabled channels are filtered HERE, the one place both consumers share:
  // they never appear in list_channels output AND never resolve in
  // create_post's platformById lookup — a disabled channel is unpostable.
  return rows.filter((row) => row.disabled !== true);
}

export interface ChannelSummary {
  id: string;
  /** Platform code (the vendor calls it `identifier`), e.g. "x", "linkedin". */
  platform: string;
  name: string;
}

export async function listChannels(): Promise<{
  channels: ChannelSummary[];
  truncated: boolean;
}> {
  const rows = await fetchIntegrations();
  const channels: ChannelSummary[] = rows.slice(0, MAX_CHANNELS).map((row) => ({
    id: typeof row.id === "string" ? row.id : "",
    platform: typeof row.identifier === "string" ? row.identifier : "",
    name: typeof row.name === "string" ? row.name : "",
  }));
  return { channels, truncated: rows.length > MAX_CHANNELS };
}

export interface CreatePostResult {
  status: "scheduled";
  /** Normalized ISO datetime the post will go out at. */
  scheduledFor: string;
  /** One row per target channel. */
  posts: { postId: string; channelId: string }[];
  /** Reminder for the model: this is a scheduled, cancellable post. */
  note: string;
}

export async function createPost(
  args: Record<string, unknown>,
): Promise<CreatePostResult> {
  // ── Validate everything BEFORE any network call ───────────────────────────
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) throw new ToolError("`text` is required and must be non-empty", 400);
  if (text.length > MAX_POST_CHARS) {
    throw new ToolError(
      `\`text\` is too long for one create_post call (max ${MAX_POST_CHARS} characters). ` +
        "Shorten the post.",
      400,
    );
  }

  const channelIds = Array.isArray(args.channelIds) ? args.channelIds : null;
  if (!channelIds || channelIds.length < 1 || channelIds.length > MAX_POST_CHANNELS) {
    throw new ToolError(
      `\`channelIds\` must list 1-${MAX_POST_CHANNELS} channel ids from list_channels`,
      400,
    );
  }
  for (const id of channelIds) {
    if (typeof id !== "string" || !CHANNEL_ID_RE.test(id)) {
      throw new ToolError(
        "Every entry in `channelIds` must be a channel id exactly as returned by list_channels",
        400,
      );
    }
  }
  const ids = channelIds as string[];

  // ── SCHEDULE-ONLY enforcement (see module header) ─────────────────────────
  const scheduleAtRaw = typeof args.scheduleAt === "string" ? args.scheduleAt.trim() : "";
  const scheduleMs = scheduleAtRaw ? Date.parse(scheduleAtRaw) : NaN;
  if (!scheduleAtRaw || Number.isNaN(scheduleMs)) {
    throw new ToolError(SCHEDULE_ONLY_COPY, 400);
  }
  // Parseable but timezone-less → its own instructive refusal (see TZ_REQUIRED_COPY).
  if (!TZ_OFFSET_RE.test(scheduleAtRaw)) {
    throw new ToolError(TZ_REQUIRED_COPY, 400);
  }
  if (
    // MIN lead + ~60s skew pad (clock skew + lookup latency; copy unchanged).
    scheduleMs < Date.now() + MIN_SCHEDULE_LEAD_MS + SCHEDULE_SKEW_PAD_MS ||
    scheduleMs > Date.now() + MAX_SCHEDULE_AHEAD_MS
  ) {
    throw new ToolError(SCHEDULE_ONLY_COPY, 400);
  }
  const scheduledFor = new Date(scheduleMs).toISOString();

  // ── Derive each channel's platform SERVER-SIDE from a fresh lookup ───────
  // settings.__type steers Postiz's per-platform behavior; it must come from
  // the vendor's own integration record, never from a model-supplied string.
  const integrations = await fetchIntegrations();
  const platformById = new Map<string, string>();
  for (const row of integrations) {
    if (typeof row.id === "string" && typeof row.identifier === "string") {
      platformById.set(row.id, row.identifier);
    }
  }
  const platforms: string[] = [];
  for (const id of ids) {
    const platform = platformById.get(id);
    if (!platform) {
      throw new ToolError(
        `Channel id "${id}" is not one of this account's channels — call list_channels and use ids from it; never invent channel ids`,
        400,
      );
    }
    platforms.push(platform);
  }

  // Minimal {__type} settings (v1): of the ~32 platforms, ~25 declare richer
  // settings schemas — those may reject the post with a vendor 400, which we
  // normalize below without echoing vendor field names.
  const body = {
    type: "schedule" as const, // NEVER "now" — see module header
    date: scheduledFor,
    shortLink: false,
    tags: [],
    posts: ids.map((id, i) => ({
      integration: { id },
      value: [{ content: text, image: [] }],
      settings: { __type: platforms[i] },
    })),
  };

  const res = await postiz(
    "/posts",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    () =>
      new ToolError(
        `Postiz rejected the post settings for ${[...new Set(platforms)].join(", ")} — ` +
          "this platform may need options the binding doesn't support yet",
        502,
      ),
  );

  let created: unknown;
  try {
    created = await res.json();
  } catch {
    throw new ToolError("Postiz returned an unreadable create-post response", 502);
  }
  const rows = Array.isArray(created) ? created : [];
  const posts = rows.slice(0, MAX_POST_CHANNELS).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      postId: typeof row.postId === "string" ? row.postId : "",
      channelId: typeof row.integration === "string" ? row.integration : "",
    };
  });

  return {
    status: "scheduled",
    scheduledFor,
    posts,
    note: "Scheduled, not published — the user can review or cancel it in Postiz before it goes live.",
  };
}
