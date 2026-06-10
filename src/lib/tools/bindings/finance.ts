/**
 * Stock-quote binding — embeds yahoo-finance2
 * (https://github.com/gadicc/yahoo-finance2, MIT, by Gadi Cohen), the
 * unofficial TypeScript Yahoo Finance client. Quotes, search, and historical
 * data with no API key; this binding exposes the single highest-value call
 * (live quote) trimmed to agent-friendly fields.
 *
 * Note: yahoo-finance2 v3 recommends Node >= 22; it runs on Node 20 with a
 * startup advisory. The client is created lazily so importing the registry
 * never triggers network or environment checks.
 */
import YahooFinance from "yahoo-finance2";
import { ToolError } from "../manifest";

/** Ticker shapes Yahoo accepts: AAPL, BRK-B, ^GSPC, EURUSD=X, BTC-USD. */
const SYMBOL_RE = /^[A-Za-z0-9^.=-]{1,12}$/;

let client: InstanceType<typeof YahooFinance> | null = null;
function yahoo(): InstanceType<typeof YahooFinance> {
  if (!client) client = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  return client;
}

export interface StockQuoteResult {
  symbol: string;
  name?: string;
  price?: number;
  currency?: string;
  change?: number;
  changePercent?: number;
  previousClose?: number;
  dayHigh?: number;
  dayLow?: number;
  marketCap?: number;
  marketState?: string;
  exchange?: string;
  quoteType?: string;
  source: string;
}

export async function stockQuote(args: Record<string, unknown>): Promise<StockQuoteResult> {
  const symbol = typeof args.symbol === "string" ? args.symbol.trim().toUpperCase() : "";
  if (!symbol) throw new ToolError("Missing required argument: symbol", 400);
  if (!SYMBOL_RE.test(symbol)) {
    throw new ToolError(`Invalid symbol "${symbol}" (expected a ticker like AAPL or BTC-USD)`, 400);
  }

  let q;
  try {
    q = await yahoo().quote(symbol);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|no.*result/i.test(msg)) throw new ToolError(`Unknown symbol: ${symbol}`, 404);
    throw new ToolError(`Yahoo Finance unreachable: ${msg}`, 502);
  }
  if (!q) throw new ToolError(`Unknown symbol: ${symbol}`, 404);

  return {
    symbol: q.symbol ?? symbol,
    name: q.longName ?? q.shortName,
    price: q.regularMarketPrice,
    currency: q.currency,
    change: q.regularMarketChange,
    changePercent: q.regularMarketChangePercent,
    previousClose: q.regularMarketPreviousClose,
    dayHigh: q.regularMarketDayHigh,
    dayLow: q.regularMarketDayLow,
    marketCap: q.marketCap,
    marketState: q.marketState,
    exchange: q.fullExchangeName,
    quoteType: q.quoteType,
    source: "Yahoo Finance via yahoo-finance2",
  };
}
