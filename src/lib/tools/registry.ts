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
 * All three launch tools are open-source, keyless, and individually authored —
 * see TOOL-OPENSOURCE-properchats.md at the repo root for attribution and
 * license notes.
 */
import { TOOL_NAME_SEP, ToolError, type ToolManifest } from "./manifest";
import { calculate } from "./bindings/calculator";
import { stockQuote } from "./bindings/finance";
import { scrapeUrl, searchWeb } from "./bindings/firecrawl";
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
 * Invoke one declared function of a registered tool. Throws `ToolError` with
 * an HTTP status hint (404 unknown tool/function, 400 bad args, 501 binding
 * not locally invokable, 502 upstream failure).
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
  meterToolCall(manifest, functionName);
  return handler(args);
}
