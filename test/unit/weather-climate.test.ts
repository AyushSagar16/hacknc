import { afterEach, describe, expect, it } from "vitest";
import { climatology, forecastOutlook, outlook, outlookBubble } from "../../src/weather/climate.ts";
import { clearOutlookCache, getWeather, setWeatherFetch } from "../../src/agent/features/weather.ts";
import type { ToolCtx } from "../../src/agent/tools.ts";
import type { Action } from "../../src/transport/outbound.ts";

const days = (start: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

/** A fake Open-Meteo: archive years get highs 48/50/52, forecast gets two wet days. */
function fakeMeteo(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname.startsWith("archive-api")) {
      const s = url.searchParams.get("start_date")!;
      const e = url.searchParams.get("end_date")!;
      const n = Math.round((Date.parse(e) - Date.parse(s)) / 86_400_000) + 1;
      const hi = { "2025": 48, "2024": 50, "2023": 52 }[s.slice(0, 4)] ?? 50;
      const precip = days(s, n).map((_, i) => (i < 2 ? 0.3 : 0));
      return Response.json({ daily: { time: days(s, n), temperature_2m_max: Array(n).fill(hi), temperature_2m_min: Array(n).fill(30), precipitation_sum: precip } });
    }
    if (url.hostname.startsWith("geocoding")) return Response.json({ results: [{ name: "Asheville", latitude: 35.6, longitude: -82.55, timezone: "America/New_York" }] });
    const t = days("2026-10-10", 16);
    return Response.json({
      daily: {
        time: t,
        weather_code: t.map((_, i) => (i === 3 || i === 4 ? 63 : 1)),
        precipitation_probability_max: t.map((_, i) => (i === 3 || i === 4 ? 80 : 5)),
        temperature_2m_max: t.map(() => 72),
        temperature_2m_min: t.map(() => 50),
        wind_gusts_10m_max: t.map(() => 10),
      },
    });
  }) as typeof fetch;
}

afterEach(() => {
  setWeatherFetch(undefined);
  clearOutlookCache();
});

describe("climatology", () => {
  it("averages the same dates over the last three finished years", async () => {
    const calls: string[] = [];
    const o = await climatology(35.6, -82.55, "2026-12-16", "2026-12-23", "2026-10-10", { fetch: fakeMeteo(calls) });
    expect(o).toMatchObject({ kind: "usually", highF: 50, lowF: 30, rainyDays: 2, days: 8, years: [2025, 2024, 2023] });
    expect(calls.some((c) => c.includes("start_date=2025-12-16") && c.includes("end_date=2025-12-23"))).toBe(true);
    expect(outlookBubble("Asheville, NC", o)).toBe("asheville, dec 16–23 (usually): highs ~50°, lows ~30°, a couple rainy days. pack layers and a warm coat + a rain jacket");
  });

  it("uses the forecast inside two weeks and names the wet days", async () => {
    const o = await outlook(35.6, -82.55, "2026-10-12", "2026-10-15", "2026-10-10", { fetch: fakeMeteo() });
    expect(o).toMatchObject({ kind: "forecast", highF: 72, lowF: 50, rainyDays: 2, wetDays: ["2026-10-13", "2026-10-14"] });
    expect(outlookBubble("asheville", o)).toBe("asheville, oct 12–15 (forecast): highs ~72°, lows ~50°, rain likely tue and wed. bring a rain jacket");
    expect(forecastOutlook([], "2026-10-12", "2026-10-15")).toBeNull();
  });
});

describe("get_weather tool", () => {
  const ctx = (trip: Record<string, unknown>) => {
    const out: Action[] = [];
    return { out, today: "2026-10-10", trip: { id: 1, destination_id: null, latitude: null, longitude: null, ...trip }, notes: new Map() } as unknown as ToolCtx & { out: Action[] };
  };

  it("posts one line for the trip's place and dates", async () => {
    setWeatherFetch(fakeMeteo());
    const c = ctx({ destination_name: "Asheville, NC", start_date: "2026-12-16", end_date: "2026-12-23" });
    const r = await getWeather.run({}, c);
    expect(r).toMatchObject({ ok: true, data: { kind: "usually", high_f: 50, low_f: 30 } });
    expect(c.out).toEqual([{ type: "say", text: expect.stringMatching(/^asheville, dec 16–23 \(usually\): highs ~50°/) }]);
    expect(getWeather.soloPost).toBe(true);
  });

  it("asks for dates instead of guessing", async () => {
    setWeatherFetch(fakeMeteo());
    const r = await getWeather.run({}, ctx({ destination_name: "Asheville, NC", start_date: null, end_date: null }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("no dates yet") });
  });

  it("fails in plain words when the API is down", async () => {
    setWeatherFetch((async () => new Response("bad", { status: 500 })) as unknown as typeof fetch);
    const r = await getWeather.run({}, ctx({ destination_name: "Asheville, NC", latitude: 35.6, longitude: -82.55, start_date: "2026-12-16", end_date: "2026-12-23" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("don't guess temperatures") });
  });
});
