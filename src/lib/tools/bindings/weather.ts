/**
 * Weather binding — proxies wttr.in (https://github.com/chubin/wttr.in,
 * Apache-2.0, by Igor Chubin), the open-source, keyless weather service.
 * `GET https://wttr.in/<location>?format=j1` returns full JSON current
 * conditions plus a 3-day forecast for any city / airport code / lat,lng.
 * No API key, so `auth.secrets` is empty; the bridge only trims the (large)
 * upstream JSON down to what an agent turn needs.
 */
import { ToolError } from "../manifest";

const WTTR_BASE = process.env.WTTR_BASE_URL || "https://wttr.in";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_LOCATION_LENGTH = 100;

interface WttrCondition {
  temp_C?: string;
  temp_F?: string;
  FeelsLikeC?: string;
  humidity?: string;
  windspeedKmph?: string;
  winddir16Point?: string;
  precipMM?: string;
  weatherDesc?: { value?: string }[];
}

interface WttrDay {
  date?: string;
  maxtempC?: string;
  mintempC?: string;
  maxtempF?: string;
  mintempF?: string;
  hourly?: WttrCondition[];
}

interface WttrResponse {
  current_condition?: WttrCondition[];
  weather?: WttrDay[];
  nearest_area?: { areaName?: { value?: string }[]; country?: { value?: string }[] }[];
}

function describe(c: WttrCondition | undefined): string | undefined {
  return c?.weatherDesc?.[0]?.value;
}

export interface WeatherResult {
  /** The location as requested. */
  location: string;
  /** The nearest area wttr.in resolved it to (may be a district/suburb). */
  resolvedArea?: string;
  current: {
    description?: string;
    tempC?: string;
    tempF?: string;
    feelsLikeC?: string;
    humidityPct?: string;
    windKmph?: string;
    windDir?: string;
    precipMM?: string;
  };
  forecast: {
    date?: string;
    minC?: string;
    maxC?: string;
    minF?: string;
    maxF?: string;
    middayDescription?: string;
  }[];
  source: string;
}

export async function getWeather(args: Record<string, unknown>): Promise<WeatherResult> {
  const location = typeof args.location === "string" ? args.location.trim() : "";
  if (!location) throw new ToolError("Missing required argument: location", 400);
  if (location.length > MAX_LOCATION_LENGTH) {
    throw new ToolError(`Location too long (max ${MAX_LOCATION_LENGTH} chars)`, 400);
  }

  let res: Response;
  try {
    res = await fetch(`${WTTR_BASE}/${encodeURIComponent(location)}?format=j1`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "properchats-tools (https://github.com/interpretai-tech/properchats)" },
    });
  } catch (e) {
    throw new ToolError(`wttr.in unreachable: ${e instanceof Error ? e.message : e}`, 502);
  }
  if (res.status === 404) throw new ToolError(`Unknown location: ${location}`, 404);
  if (!res.ok) throw new ToolError(`wttr.in responded ${res.status}`, 502);

  let data: WttrResponse;
  try {
    data = (await res.json()) as WttrResponse;
  } catch {
    throw new ToolError("wttr.in returned non-JSON (likely rate-limited); try again shortly", 502);
  }

  const cur = data.current_condition?.[0];
  const area = data.nearest_area?.[0];
  const resolved = [area?.areaName?.[0]?.value, area?.country?.[0]?.value]
    .filter(Boolean)
    .join(", ");

  return {
    location,
    ...(resolved ? { resolvedArea: resolved } : {}),
    current: {
      description: describe(cur),
      tempC: cur?.temp_C,
      tempF: cur?.temp_F,
      feelsLikeC: cur?.FeelsLikeC,
      humidityPct: cur?.humidity,
      windKmph: cur?.windspeedKmph,
      windDir: cur?.winddir16Point,
      precipMM: cur?.precipMM,
    },
    forecast: (data.weather ?? []).slice(0, 3).map((d) => ({
      date: d.date,
      minC: d.mintempC,
      maxC: d.maxtempC,
      minF: d.mintempF,
      maxF: d.maxtempF,
      middayDescription: describe(d.hourly?.[Math.floor((d.hourly?.length ?? 0) / 2)]),
    })),
    source: "wttr.in",
  };
}
