/**
 * The tool registry described in docs/PUBLIC_TOOL_ECOSYSTEM.md §2.3: a typed
 * `TOOL_MANIFESTS` array (register), helpers for lookup (discover), and
 * `invokeTool` — the invocation seam the webhook bridge route
 * (`/api/tools/[tool]`) dispatches through.
 *
 * These manifests are *additive*: they do not extend the `Capability` union or
 * the picker yet (that derivation step is described in the doc and tracked
 * separately). What is real today: each webhook-bound tool below is callable
 * end-to-end via `POST /api/tools/<id>` with `{ "function": "...", "args": {...} }`.
 *
 * Every tool here is open-source and individually authored — the launch trio
 * is keyless; later additions (web_scrape, tts) are BYOK and strip when
 * unconfigured —
 * see TOOL-OPENSOURCE-properchats.md at the repo root for attribution and
 * license notes.
 */
import { rateLimit } from "@/lib/server/rateLimit";
import { TOOL_NAME_SEP, ToolError, type ToolManifest } from "./manifest";
import { calculate } from "./bindings/calculator";
import { listVoices, textToSpeech } from "./bindings/elevenlabs";
import { stockQuote } from "./bindings/finance";
import { scrapeUrl, searchWeb } from "./bindings/firecrawl";
import { createPost, listChannels } from "./bindings/postiz";
import { getWeather } from "./bindings/weather";

const UNMETERED = {
  free: "unmetered",
  basic: "unmetered",
  monthly: "unmetered",
  insane: "unmetered",
} as const;

export const TOOL_MANIFESTS: ToolManifest[] = [
  {
    id: "weather",
    display: {
      label: "Weather",
      hint: "Current conditions and 3-day forecast for any place",
      icon: "CloudSun",
    },
    description:
      "get_weather returns live current conditions (temp, feels-like, humidity, " +
      "wind, precipitation) and a 3-day forecast for a city, airport code, or " +
      "lat,lng — via the open-source wttr.in service. Use it whenever the user " +
      "asks about weather; never guess conditions.",
    binding: {
      kind: "webhook",
      endpoint: "/api/tools/weather",
      functions: [
        {
          name: "get_weather",
          description: "Current weather and 3-day forecast for a location.",
          parameters: {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: 'City name, airport code, or "lat,lng" (e.g. "Paris", "SFO", "48.85,2.35").',
              },
            },
            required: ["location"],
          },
        },
      ],
    },
    providers: ["anthropic", "openai", "gemini"],
    auth: { requiresSignIn: false },
    policy: { allowance: UNMETERED, meterMode: "per-turn" },
    upstream: {
      project: "wttr.in",
      repo: "https://github.com/chubin/wttr.in",
      license: "Apache-2.0",
      author: "Igor Chubin",
    },
    category: "data",
    pricing: "keyless",
    maintainer: "ilianherzi",
  },
  {
    id: "calculator",
    display: {
      label: "Calculator",
      hint: "Exact math, unit conversion, and percentages",
      icon: "Calculator",
    },
    description:
      "calculate evaluates a math expression deterministically with mathjs: " +
      'arithmetic, unit conversion ("12.5 cm to inch"), percentages, ' +
      "matrices, and statistics. Use it for any numeric answer instead of " +
      "doing arithmetic in your head.",
    binding: {
      kind: "webhook",
      endpoint: "/api/tools/calculator",
      functions: [
        {
          name: "calculate",
          description: "Evaluate a mathjs expression and return the exact result.",
          parameters: {
            type: "object",
            properties: {
              expression: {
                type: "string",
                description: 'A mathjs expression, e.g. "sqrt(3^2 + 4^2)" or "12.5 cm to inch".',
              },
            },
            required: ["expression"],
          },
        },
      ],
    },
    providers: ["anthropic", "openai", "gemini"],
    auth: { requiresSignIn: false },
    policy: { allowance: UNMETERED, meterMode: "per-turn" },
    upstream: {
      project: "mathjs",
      repo: "https://github.com/josdejong/mathjs",
      license: "Apache-2.0",
      author: "Jos de Jong",
    },
    category: "productivity",
    pricing: "keyless",
    maintainer: "ilianherzi",
  },
  {
    id: "stock_quote",
    display: {
      label: "Stocks",
      hint: "Live stock, index, FX, and crypto quotes",
      icon: "TrendingUp",
    },
    description:
      "stock_quote returns the live price, change, day range, market cap, and " +
      "market state for a ticker (AAPL, ^GSPC, EURUSD=X, BTC-USD) via the " +
      "open-source yahoo-finance2 client. Use it whenever the user asks about " +
      "a market price; never quote a price from memory.",
    binding: {
      kind: "webhook",
      endpoint: "/api/tools/stock_quote",
      functions: [
        {
          name: "stock_quote",
          description: "Live market quote for a stock/index/FX/crypto ticker.",
          parameters: {
            type: "object",
            properties: {
              symbol: {
                type: "string",
                description: 'Ticker symbol, e.g. "AAPL", "BRK-B", "^GSPC", "BTC-USD".',
              },
            },
            required: ["symbol"],
          },
        },
      ],
    },
    providers: ["anthropic", "openai", "gemini"],
    auth: { requiresSignIn: false },
    policy: { allowance: UNMETERED, meterMode: "per-turn" },
    upstream: {
      project: "yahoo-finance2",
      repo: "https://github.com/gadicc/yahoo-finance2",
      license: "MIT",
      author: "Gadi Cohen",
    },
    category: "finance",
    pricing: "keyless",
    maintainer: "ilianherzi",
  },

  {
    id: "web_scrape",
    display: {
      label: "Web scrape",
      hint: "Read any web page as markdown, or search the web",
      icon: "Globe",
    },
    description:
      "scrape_url fetches a web page through Firecrawl and returns its main " +
      "content as markdown (use it to READ a specific page the user names or " +
      "a result you found); search_web returns up to 5 {title, url, snippet} " +
      "results for a query. Prefer scrape_url over guessing page contents; " +
      "results may be truncated — say so when `truncated` is true.",
    binding: {
      kind: "webhook",
      endpoint: "/api/tools/web_scrape",
      functions: [
        {
          name: "scrape_url",
          description: "Fetch one http(s) page as LLM-ready markdown.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Absolute http(s) URL to read." },
              only_main_content: {
                type: "boolean",
                description: "Strip nav/boilerplate (default true).",
              },
            },
            required: ["url"],
          },
        },
        {
          name: "search_web",
          description: "Web search returning up to 5 results with snippets.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "The search query." },
              limit: { type: "number", description: "Max results, 1-5 (default 5)." },
            },
            required: ["query"],
          },
        },
      ],
    },
    providers: ["anthropic", "openai", "gemini"],
    auth: { requiresSignIn: false, secrets: ["FIRECRAWL_API_KEY"] },
    policy: { allowance: UNMETERED, meterMode: "per-turn" },
    upstream: {
      project: "Firecrawl",
      repo: "https://github.com/firecrawl/firecrawl",
      license: "AGPL-3.0",
      author: "Firecrawl (Mendable.ai)",
    },
    category: "data",
    pricing: "byok",
    maintainer: "ilianherzi",
  },

  {
    id: "tts",
    display: {
      label: "Text to speech",
      hint: "Turn text into lifelike spoken audio (ElevenLabs, BYOK — vendor bills per character; free tier 10k chars/mo)",
      icon: "Volume2",
    },
    description:
      "text_to_speech converts text (max 2,500 characters per call) into a " +
      "spoken audio clip via ElevenLabs and returns clip METADATA only " +
      "(voiceId, characters, contentType, bytes) — the audio file itself is " +
      "delivered to the user's interface, never into this conversation, so " +
      "never ask for or try to repeat the audio data. Use it when the user " +
      "asks to hear text read aloud, narrated, or turned into voice audio. " +
      "list_voices returns the available voice ids with names and labels; " +
      "call it first when the user wants a specific kind of voice.",
    binding: {
      kind: "webhook",
      endpoint: "/api/tools/tts",
      functions: [
        {
          name: "text_to_speech",
          description:
            "Synthesize one audio clip (audio/mpeg) from text; returns clip metadata, not audio data.",
          parameters: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: "The text to speak, up to 2,500 characters.",
              },
              voiceId: {
                type: "string",
                description:
                  'ElevenLabs voice id from list_voices (default "21m00Tcm4TlvDq8ikWAM" — "Rachel", a premade voice).',
              },
            },
            required: ["text"],
          },
        },
        {
          name: "list_voices",
          description:
            "List available ElevenLabs voices as compact {id, name, labels} rows (capped at 25).",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    providers: ["anthropic", "openai", "gemini"],
    auth: { requiresSignIn: false, secrets: ["ELEVENLABS_API_KEY"] },
    policy: { allowance: UNMETERED, meterMode: "per-turn" },
    category: "media",
    pricing: "byok",
    maintainer: "ilianherzi",
  },

  {
    id: "social_post",
    display: {
      label: "Social post",
      hint:
        "Schedule posts to connected social accounts via Postiz (BYOK — self-host free under AGPL, cloud from $29/mo; vendor caps ~90-100 create-calls/hour). " +
        "SHARED AUTHORITY: one Postiz workspace per deployment — every user of this server posts through the same connected accounts.",
      icon: "Share2",
    },
    description:
      "list_channels returns the connected social accounts as " +
      "{id, platform, name} rows; create_post schedules ONE text post to 1-5 " +
      "of those channels at `scheduleAt`. Call list_channels first and use " +
      "ids from it; never invent channel ids. SCHEDULING IS MANDATORY: posts " +
      "are always scheduled at least 10 minutes out so the user can review/" +
      "cancel in Postiz; never claim a post was published immediately — " +
      "immediate posting is deliberately unsupported. After a successful " +
      "create_post, tell the user when the post is scheduled for and that " +
      "they can still cancel it in Postiz. SHARING MODEL: the server is " +
      "configured with ONE deployer-scoped Postiz workspace — all users of " +
      "this deployment share its connected accounts; there are no per-user " +
      "accounts here.",
    binding: {
      kind: "webhook",
      endpoint: "/api/tools/social_post",
      functions: [
        {
          name: "list_channels",
          description:
            "List connected social channels as compact {id, platform, name} rows (capped at 50). Call this before create_post.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "create_post",
          description:
            "Schedule one text post to 1-5 channels. Requires scheduleAt — an ISO datetime at least 10 minutes in the future (there is NO immediate-post option); the user can cancel the scheduled post in Postiz.",
          parameters: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: "The post text, up to 5,000 characters.",
              },
              channelIds: {
                type: "array",
                items: { type: "string" },
                description:
                  "1-5 channel ids exactly as returned by list_channels.",
              },
              scheduleAt: {
                type: "string",
                description:
                  'ISO 8601 datetime to publish at, e.g. "2026-06-12T15:30:00Z". Must include an explicit timezone (a trailing "Z" or ±HH:MM offset), be at least 10 minutes in the future, and at most 1 year out.',
              },
            },
            required: ["text", "channelIds", "scheduleAt"],
          },
        },
      ],
    },
    providers: ["anthropic", "openai", "gemini"],
    // requiresSignIn is declarative today (see the manifest contract): this
    // repo has no session system to enforce it, but social_post is SHARED
    // AUTHORITY — POSTIZ_API_KEY is deployer-scoped, so any caller acts on
    // the deployment's real accounts. Flagging it true so a session-bearing
    // host app gates it, and so the sharing model is manifest-visible.
    auth: { requiresSignIn: true, secrets: ["POSTIZ_API_KEY"] },
    policy: { allowance: UNMETERED, meterMode: "per-turn" },
    upstream: {
      project: "Postiz",
      repo: "https://github.com/gitroomhq/postiz-app",
      license: "AGPL-3.0",
      author: "Gitroom (Nevo David)",
    },
    category: "social",
    pricing: "byok",
    maintainer: "ilianherzi",
  },
];

/**
 * Registration-time invariant: a tool id must not contain the model-facing
 * name separator (`__`). `parseToolDefName` resolves `<toolId>__<fn>` by
 * first registered-id-prefix match; an id containing the separator would make
 * that resolution ambiguous (one tool could shadow another's functions).
 * Throws at module load so a bad manifest can never ship.
 */
export function assertToolIdsValid(manifests: ToolManifest[] = TOOL_MANIFESTS): void {
  for (const m of manifests) {
    if (m.id.includes(TOOL_NAME_SEP)) {
      throw new Error(
        `Tool id "${m.id}" must not contain "${TOOL_NAME_SEP}" — it is reserved as the tool-name separator`,
      );
    }
  }
}
assertToolIdsValid();

export const TOOL_IDS: string[] = TOOL_MANIFESTS.map((t) => t.id);

const TOOL_BY_ID = new Map(TOOL_MANIFESTS.map((t) => [t.id, t]));

export function getToolManifest(id: string): ToolManifest | undefined {
  return TOOL_BY_ID.get(id);
}

/**
 * Bridge handlers for webhook-bound tools, keyed tool id → function name.
 * This is the loader seam: a manifest whose binding declares a function must
 * have (or gain) a handler here for `invokeTool` to dispatch to it.
 */
type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
const HANDLERS: Record<string, Record<string, ToolHandler>> = {
  weather: { get_weather: getWeather },
  calculator: { calculate },
  stock_quote: { stock_quote: stockQuote },
  web_scrape: { scrape_url: scrapeUrl, search_web: searchWeb },
  tts: { text_to_speech: textToSpeech, list_voices: listVoices },
  social_post: { list_channels: listChannels, create_post: createPost },
};

/**
 * One-seam metering (TOOL_MARKETPLACE.md "meterable pricing" note): every
 * dispatch — whether it came from the `/api/tools/[tool]` bridge or from a
 * model tool-call in the chat loop — is counted here, per *invocation* (an
 * agent turn can call one tool dozens of times). In-memory counter plus a
 * labeled debug line shaped for the cost plane (OTEL → Prometheus) to pick up
 * later. Labels carry key *aliases* (env var names), never key material.
 */
const toolCallCounts = new Map<string, number>();

/** Snapshot of per-tool invocation counts (process-local; for tests/debug). */
export function getToolCallCounts(): Record<string, number> {
  return Object.fromEntries(toolCallCounts);
}

function meterToolCall(manifest: ToolManifest, fn: string): void {
  const n = (toolCallCounts.get(manifest.id) ?? 0) + 1;
  toolCallCounts.set(manifest.id, n);
  const keyAlias = manifest.auth.secrets?.[0] ?? "none";
  console.debug(
    `[metrics] tool_calls_total{tool="${manifest.id}",fn="${fn}",pricing="${manifest.pricing ?? "keyless"}",key_alias="${keyAlias}"} ${n}`,
  );
}

/**
 * One-seam BYOK hourly budget. History: this ceiling used to live only in the
 * bridge route (`/api/tools/[tool]`), which meant the chat loop's dispatch
 * path (`runToolDefWithUi` → `invokeTool`) bypassed it entirely — an injected
 * conversation could burn a metered key up to the vendor's own cap. It now
 * lives HERE, on the registry's single dispatch seam, so bridge calls and
 * model tool-calls drain the SAME per-tool counter (`tools:byok:<id>`).
 *
 * Limits (process-local, like rateLimit.ts — a multi-instance deploy
 * multiplies the effective ceiling by instance count):
 * - default BYOK tools: TOOLS_BYOK_TOOL_LIMIT calls/hour (60)
 * - category "social":  TOOLS_SOCIAL_TOOL_LIMIT calls/hour (15) — tools that
 *   post to real accounts get a tighter bound than scraping; a runaway loop
 *   should hit our wall long before the vendor's ~90-100/h cap.
 *
 * The budget is charged BEFORE the handler runs (a refused call must not be
 * free to retry into the vendor) but AFTER name resolution (probing unknown
 * functions doesn't drain it). Keyless tools are unaffected.
 */
const TOOLS_BYOK_TOOL_WINDOW_MS = 3_600_000;

/** Hourly call ceiling for one BYOK tool (env read per call, test-tunable). */
export function byokToolHourlyLimit(manifest: ToolManifest): number {
  if (manifest.category === "social") {
    const n = Number(process.env.TOOLS_SOCIAL_TOOL_LIMIT);
    return Number.isFinite(n) && n > 0 ? n : 15;
  }
  const n = Number(process.env.TOOLS_BYOK_TOOL_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

function chargeByokBudget(manifest: ToolManifest): void {
  if (!manifest.auth.secrets?.length) return; // keyless: no metered key to burn
  const budget = rateLimit(
    `tools:byok:${manifest.id}`,
    byokToolHourlyLimit(manifest),
    TOOLS_BYOK_TOOL_WINDOW_MS,
  );
  if (!budget.ok) {
    // In the chat loop this ToolError becomes a structured { error } result
    // (runToolDefWithUi never throws); on the bridge it becomes a 429 with
    // Retry-After. Either way the message is ours, never limiter internals.
    throw new ToolError(
      `The ${manifest.id} tool has reached its hourly budget. Try again later.`,
      429,
      budget.retryAfter,
    );
  }
}

/**
 * Invoke one declared function of a registered tool. Throws `ToolError` with
 * an HTTP status hint (404 unknown tool/function, 400 bad args, 429 hourly
 * budget exhausted, 501 binding not locally invokable, 502 upstream failure).
 */
export async function invokeTool(
  toolId: string,
  functionName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const manifest = getToolManifest(toolId);
  if (!manifest) throw new ToolError(`Unknown tool: ${toolId}`, 404);
  if (manifest.binding.kind !== "webhook") {
    throw new ToolError(
      `Tool "${toolId}" is bound to the IAI runtime (token "${manifest.binding.token}") and is not invokable from this bridge`,
      501,
    );
  }
  if (!manifest.binding.functions.some((f) => f.name === functionName)) {
    throw new ToolError(`Tool "${toolId}" has no function "${functionName}"`, 404);
  }
  const handler = HANDLERS[toolId]?.[functionName];
  if (!handler) {
    throw new ToolError(`Function "${functionName}" of "${toolId}" has no bridge handler yet`, 501);
  }
  chargeByokBudget(manifest); // throws 429 when exhausted — never reaches the handler
  meterToolCall(manifest, functionName);
  return handler(args);
}
