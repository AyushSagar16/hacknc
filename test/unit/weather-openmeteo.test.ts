// Open-Meteo client against captured fixtures: parsing, API errors, timeout, and the single retry.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fetchDailyForecast, geocode, WeatherError } from "../../src/weather/openMeteo.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/open-meteo/${name}`, import.meta.url), "utf8");

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

type Step = Response | Error | "hang" | "hang-ignoring-signal";

/** A fetch that plays back one step per call and records the URLs it saw. */
function fakeFetch(...steps: Step[]) {
  const urls: URL[] = [];
  const impl = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    urls.push(new URL(String(input)));
    const step = steps[Math.min(urls.length - 1, steps.length - 1)]!;
    if (step === "hang-ignoring-signal") return new Promise<Response>(() => {});
    if (step === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve(step.clone());
  });
  return { fetch: impl as unknown as typeof fetch, impl, urls };
}

async function caught(p: Promise<unknown>): Promise<WeatherError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(WeatherError);
    return err as WeatherError;
  }
  throw new Error("expected a WeatherError");
}

describe("geocode", () => {
  it("returns the top match with its time zone", async () => {
    const f = fakeFetch(json(fixture("geocode-lisbon.json")));
    const place = await geocode("Lisbon", { fetch: f.fetch });
    expect(place).toEqual({
      name: "Lisbon",
      latitude: 38.72509,
      longitude: -9.1498,
      timezone: "Europe/Lisbon",
      country: "Portugal",
    });
    const url = f.urls[0]!;
    expect(url.origin + url.pathname).toBe("https://geocoding-api.open-meteo.com/v1/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ name: "Lisbon", count: "1", language: "en", format: "json" });
  });

  it("returns null when nothing matches", async () => {
    const f = fakeFetch(json(fixture("geocode-empty.json")));
    expect(await geocode("Zzqxwvplm", { fetch: f.fetch })).toBeNull();
  });

  it("does not call the API for a blank name", async () => {
    const f = fakeFetch(json(fixture("geocode-lisbon.json")));
    expect(await geocode("   ", { fetch: f.fetch })).toBeNull();
    expect(f.impl).not.toHaveBeenCalled();
  });

  it("encodes names with spaces and punctuation", async () => {
    const f = fakeFetch(json(fixture("geocode-empty.json")));
    await geocode(" Charleston, SC ", { fetch: f.fetch });
    expect(f.urls[0]!.searchParams.get("name")).toBe("Charleston, SC");
  });

  it("falls back to UTC when a result has no time zone", async () => {
    const body = JSON.stringify({ results: [{ name: "Nowhere", latitude: 1, longitude: 2 }] });
    const place = await geocode("Nowhere", { fetch: fakeFetch(json(body)).fetch });
    expect(place).toEqual({ name: "Nowhere", latitude: 1, longitude: 2, timezone: "UTC" });
  });
});

describe("fetchDailyForecast", () => {
  it("parses the Charleston fixture into 16 daily rows", async () => {
    const f = fakeFetch(json(fixture("forecast-charleston.json")));
    const days = await fetchDailyForecast(32.77632, -79.93275, { fetch: f.fetch });
    expect(days).toHaveLength(16);
    expect(days[0]).toEqual({
      day: "2026-10-10",
      weatherCode: 82,
      precipProbability: 92,
      tempMaxF: 80.3,
      tempMinF: 72.2,
      windGustMph: 32.7,
    });
    expect(days[15]!.day).toBe("2026-10-25");
    expect(days.map((d) => d.day)).toEqual([...days.map((d) => d.day)].sort());
  });

  it("asks for the documented daily variables in Fahrenheit and mph", async () => {
    const f = fakeFetch(json(fixture("forecast-charleston.json")));
    await fetchDailyForecast(32.77632, -79.93275, { fetch: f.fetch });
    const url = f.urls[0]!;
    expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: "32.77632",
      longitude: "-79.93275",
      daily: "weather_code,precipitation_probability_max,temperature_2m_max,temperature_2m_min,wind_gusts_10m_max",
      timezone: "auto",
      forecast_days: "16",
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
    });
  });

  it("keeps null measurements and skips days with no weather code", async () => {
    const body = JSON.stringify({
      daily: {
        time: ["2026-10-10", "2026-10-11"],
        weather_code: [3, null],
        precipitation_probability_max: [null, 10],
        temperature_2m_max: [70, 71],
        temperature_2m_min: [null, 60],
        wind_gusts_10m_max: [12, 14],
      },
    });
    const days = await fetchDailyForecast(1, 2, { fetch: fakeFetch(json(body)).fetch });
    expect(days).toEqual([
      { day: "2026-10-10", weatherCode: 3, precipProbability: null, tempMaxF: 70, tempMinF: null, windGustMph: 12 },
    ]);
  });

  it("throws the API's reason on error JSON without retrying", async () => {
    const f = fakeFetch(json(fixture("forecast-error.json"), 400));
    const err = await caught(fetchDailyForecast(999, -79.9, { fetch: f.fetch, retryDelayMs: 1 }));
    expect(err.code).toBe("api");
    expect(err.status).toBe(400);
    expect(err.reason).toBe("Latitude must be in range of -90 to 90°. Given: 999.0.");
    expect(f.impl).toHaveBeenCalledTimes(1);
  });

  it("treats error JSON on a 200 as an error too", async () => {
    const f = fakeFetch(json(JSON.stringify({ error: true, reason: "Cannot initialize WeatherVariable" })));
    const err = await caught(fetchDailyForecast(1, 2, { fetch: f.fetch }));
    expect(err.code).toBe("api");
    expect(err.reason).toBe("Cannot initialize WeatherVariable");
  });

  it("rejects a response with the wrong shape", async () => {
    const f = fakeFetch(json(JSON.stringify({ daily: { time: ["2026-10-10"] } })));
    expect((await caught(fetchDailyForecast(1, 2, { fetch: f.fetch }))).code).toBe("invalid_response");
  });

  it("rejects series of different lengths", async () => {
    const body = JSON.parse(fixture("forecast-charleston.json")) as { daily: { temperature_2m_max: number[] } };
    body.daily.temperature_2m_max.pop();
    const f = fakeFetch(json(JSON.stringify(body)));
    const err = await caught(fetchDailyForecast(1, 2, { fetch: f.fetch }));
    expect(err.code).toBe("invalid_response");
    expect(err.reason).toMatch(/lengths/);
  });

  it("times out via the abort signal and does not retry a timeout", async () => {
    const f = fakeFetch("hang");
    const started = Date.now();
    const err = await caught(fetchDailyForecast(1, 2, { fetch: f.fetch, timeoutMs: 30, retryDelayMs: 1 }));
    expect(err.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(f.impl).toHaveBeenCalledTimes(1);
  });

  it("still times out when the fetch ignores its signal", async () => {
    const f = fakeFetch("hang-ignoring-signal");
    const err = await caught(geocode("Lisbon", { fetch: f.fetch, timeoutMs: 30 }));
    expect(err.code).toBe("timeout");
  });

  it("passes an AbortSignal to fetch", async () => {
    const f = fakeFetch(json(fixture("geocode-lisbon.json")));
    await geocode("Lisbon", { fetch: f.fetch });
    const init = f.impl.mock.calls[0]![1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries once after a 5xx", async () => {
    const f = fakeFetch(new Response("upstream down", { status: 503 }), json(fixture("forecast-charleston.json")));
    const days = await fetchDailyForecast(1, 2, { fetch: f.fetch, retryDelayMs: 1 });
    expect(days).toHaveLength(16);
    expect(f.impl).toHaveBeenCalledTimes(2);
  });

  it("retries once after a network error", async () => {
    const f = fakeFetch(new TypeError("fetch failed"), json(fixture("geocode-lisbon.json")));
    const place = await geocode("Lisbon", { fetch: f.fetch, retryDelayMs: 1 });
    expect(place?.timezone).toBe("Europe/Lisbon");
    expect(f.impl).toHaveBeenCalledTimes(2);
  });

  it("waits the backoff before retrying", async () => {
    const f = fakeFetch(new TypeError("fetch failed"), json(fixture("geocode-lisbon.json")));
    const started = Date.now();
    await geocode("Lisbon", { fetch: f.fetch, retryDelayMs: 60 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("gives up after the second 5xx", async () => {
    const f = fakeFetch(json(JSON.stringify({ error: true, reason: "overloaded" }), 502));
    const err = await caught(fetchDailyForecast(1, 2, { fetch: f.fetch, retryDelayMs: 1 }));
    expect(err.status).toBe(502);
    expect(err.reason).toBe("overloaded");
    expect(f.impl).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second network error", async () => {
    const f = fakeFetch(new TypeError("fetch failed"));
    const err = await caught(geocode("Lisbon", { fetch: f.fetch, retryDelayMs: 1 }));
    expect(err.code).toBe("network");
    expect(err.reason).toBe("fetch failed");
    expect(f.impl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a plain 4xx", async () => {
    const f = fakeFetch(new Response("nope", { status: 404 }));
    const err = await caught(geocode("Lisbon", { fetch: f.fetch, retryDelayMs: 1 }));
    expect(err.code).toBe("http");
    expect(err.status).toBe(404);
    expect(f.impl).toHaveBeenCalledTimes(1);
  });

  it("rejects a 200 that is not JSON", async () => {
    const f = fakeFetch(new Response("<html>", { status: 200 }));
    expect((await caught(geocode("Lisbon", { fetch: f.fetch }))).code).toBe("invalid_response");
  });
});
