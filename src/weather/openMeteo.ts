// Open-Meteo client (free, no key): place geocoding and the 16-day daily forecast.
// Network goes only through the injected fetch; every call has a timeout and one retry on 5xx/network.
import { z } from "zod";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

/** Days of forecast requested; day 0 is "today" at the location. */
export const FORECAST_DAYS = 16;
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_RETRY_DELAY_MS = 500;

export interface OpenMeteoDeps {
  fetch: typeof fetch;
  timeoutMs?: number;
  /** Backoff before the single retry. Tests pass a small value. */
  retryDelayMs?: number;
}

export interface GeocodeResult {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
  country?: string;
}

export interface DailyForecast {
  day: string;
  weatherCode: number;
  precipProbability: number | null;
  tempMaxF: number | null;
  tempMinF: number | null;
  windGustMph: number | null;
}

export type WeatherErrorCode = "api" | "http" | "timeout" | "network" | "invalid_response";

export class WeatherError extends Error {
  override readonly name = "WeatherError";
  readonly code: WeatherErrorCode;
  /** The API's own reason when it sent one, otherwise our description. */
  readonly reason: string;
  readonly status: number | undefined;

  constructor(code: WeatherErrorCode, reason: string, status?: number, options?: { cause?: unknown }) {
    super(`open-meteo ${code}${status ? ` ${status}` : ""}: ${reason}`, options);
    this.code = code;
    this.reason = reason;
    this.status = status;
  }

  get retryable(): boolean {
    return this.code === "network" || (this.status !== undefined && this.status >= 500);
  }
}

const GeocodeBody = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        timezone: z.string().optional(),
        country: z.string().optional(),
      }),
    )
    .optional(),
});

const series = z.array(z.number().nullable());
const ForecastBody = z.object({
  daily: z.object({
    time: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    weather_code: series,
    precipitation_probability_max: series,
    temperature_2m_max: series,
    temperature_2m_min: series,
    wind_gusts_10m_max: series,
  }),
});

const ErrorBody = z.object({ error: z.literal(true), reason: z.string() });

/** Resolve a place name to coordinates and its IANA time zone. Null when nothing matches. */
export async function geocode(name: string, deps: OpenMeteoDeps): Promise<GeocodeResult | null> {
  const query = name.trim();
  if (!query) return null;
  const params = new URLSearchParams({ name: query, count: "1", language: "en", format: "json" });
  const body = await requestJson(`${GEOCODE_URL}?${params}`, deps);
  const parsed = GeocodeBody.safeParse(body);
  if (!parsed.success) throw new WeatherError("invalid_response", `unexpected geocoding shape: ${parsed.error.message}`);
  const top = parsed.data.results?.[0];
  if (!top) return null;
  return {
    name: top.name,
    latitude: top.latitude,
    longitude: top.longitude,
    timezone: top.timezone ?? "UTC",
    ...(top.country ? { country: top.country } : {}),
  };
}

/** Daily forecast for the next 16 local days (Fahrenheit, mph), in the location's own time zone. */
export async function fetchDailyForecast(lat: number, lon: number, deps: OpenMeteoDeps): Promise<DailyForecast[]> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: "weather_code,precipitation_probability_max,temperature_2m_max,temperature_2m_min,wind_gusts_10m_max",
    timezone: "auto",
    forecast_days: String(FORECAST_DAYS),
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
  });
  const body = await requestJson(`${FORECAST_URL}?${params}`, deps);
  const parsed = ForecastBody.safeParse(body);
  if (!parsed.success) throw new WeatherError("invalid_response", `unexpected forecast shape: ${parsed.error.message}`);

  const d = parsed.data.daily;
  const n = d.time.length;
  const columns = [d.weather_code, d.precipitation_probability_max, d.temperature_2m_max, d.temperature_2m_min, d.wind_gusts_10m_max];
  if (columns.some((c) => c.length !== n)) throw new WeatherError("invalid_response", "daily series lengths differ");

  const out: DailyForecast[] = [];
  for (let i = 0; i < n; i++) {
    const code = d.weather_code[i];
    // A day with no weather code can't be classified; skip it rather than invent one.
    if (code === null || code === undefined) continue;
    out.push({
      day: d.time[i]!,
      weatherCode: code,
      precipProbability: d.precipitation_probability_max[i] ?? null,
      tempMaxF: d.temperature_2m_max[i] ?? null,
      tempMinF: d.temperature_2m_min[i] ?? null,
      windGustMph: d.wind_gusts_10m_max[i] ?? null,
    });
  }
  return out;
}

export async function requestJson(url: string, deps: OpenMeteoDeps): Promise<unknown> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  try {
    return await attempt(url, deps.fetch, timeoutMs);
  } catch (err) {
    // Timeouts are not retried so a stuck API costs at most one timeout.
    if (!(err instanceof WeatherError) || !err.retryable) throw err;
    await sleep(retryDelayMs);
    return attempt(url, deps.fetch, timeoutMs);
  }
}

async function attempt(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = (cause: unknown) => new WeatherError("timeout", `no response within ${timeoutMs}ms`, undefined, { cause });

  let res: Response;
  try {
    res = await raceAbort(fetchImpl(url, { signal, headers: { accept: "application/json" } }), signal);
  } catch (err) {
    if (signal.aborted) throw timedOut(err);
    throw new WeatherError("network", err instanceof Error ? err.message : String(err), undefined, { cause: err });
  }

  let body: unknown;
  let jsonOk = true;
  try {
    body = await raceAbort(res.json() as Promise<unknown>, signal);
  } catch (err) {
    if (signal.aborted) throw timedOut(err);
    jsonOk = false;
  }

  const apiError = ErrorBody.safeParse(body);
  if (apiError.success) throw new WeatherError("api", apiError.data.reason, res.status);
  if (!res.ok) throw new WeatherError("http", `HTTP ${res.status}`, res.status);
  if (!jsonOk) throw new WeatherError("invalid_response", "response body was not JSON", res.status);
  return body;
}

/** Reject on abort even if the fetch implementation ignores its signal. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
