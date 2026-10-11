// "What's the weather like there?" for any trip dates. Inside the forecast window it's the real
// Open-Meteo forecast; further out it's what those same dates were like the last few years
// (Open-Meteo's free archive), labeled "usually". Deterministic: the numbers come from the API,
// the words from fixed rules, so the agent never has to guess a temperature.
import { addDays } from "../clock.ts";
import { z } from "zod";
import { classify, isWet } from "./classify.ts";
import { fetchDailyForecast, requestJson, WeatherError, type DailyForecast, type OpenMeteoDeps } from "./openMeteo.ts";

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
/** Forecast days we trust for a trip summary (the API gives 16, the tail is shaky). */
export const FORECAST_TRUST_DAYS = 14;
/** A day with at least this much precipitation counts as a rainy day. */
const RAINY_INCHES = 0.04;
const RAINY_PCT = 50;

export interface WeatherOutlook {
  kind: "forecast" | "usually";
  start: string;
  end: string;
  /** Average daily high / low (°F), rounded. */
  highF: number;
  lowF: number;
  /** Warmest high and coldest low seen. */
  maxHighF: number;
  minLowF: number;
  /** Rainy (or snowy) days in the range: a forecast count, or the yearly average for "usually". */
  rainyDays: number;
  days: number;
  /** Forecast only: the wet days by date. */
  wetDays?: string[];
  /** Usually only: which years were averaged. */
  years?: number[];
}

const ArchiveBody = z.object({
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_max: z.array(z.number().nullable()),
    temperature_2m_min: z.array(z.number().nullable()),
    precipitation_sum: z.array(z.number().nullable()),
  }),
});

const shiftYear = (iso: string, years: number) => {
  const y = Number(iso.slice(0, 4)) + years;
  const md = iso.slice(5) === "02-29" ? "02-28" : iso.slice(5);
  return `${y}-${md}`;
};

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Same calendar dates over the last `years` complete years, averaged. */
export async function climatology(lat: number, lon: number, start: string, end: string, today: string, deps: OpenMeteoDeps, years = 3): Promise<WeatherOutlook> {
  // The most recent year whose copy of the range is already over (the archive lags ~5 days).
  let back = 1;
  while (shiftYear(end, -back) > addDays(today, -6)) back++;
  const highs: number[] = [];
  const lows: number[] = [];
  const rainyPerYear: number[] = [];
  const used: number[] = [];
  const spans = Array.from({ length: years }, (_, i) => ({ s: shiftYear(start, -(back + i)), e: shiftYear(end, -(back + i)) }));
  const bodies = await Promise.all(
    spans.map(async ({ s, e }) => {
      const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        start_date: s,
        end_date: e,
        daily: "temperature_2m_max,temperature_2m_min,precipitation_sum",
        temperature_unit: "fahrenheit",
        precipitation_unit: "inch",
        timezone: "auto",
      });
      try {
        return ArchiveBody.parse(await requestJson(`${ARCHIVE_URL}?${params}`, deps));
      } catch {
        return null; // one missing year still leaves an average
      }
    }),
  );
  bodies.forEach((b, i) => {
    if (!b) return;
    const d = b.daily;
    let rainy = 0;
    let any = false;
    for (let k = 0; k < d.time.length; k++) {
      const hi = d.temperature_2m_max[k];
      const lo = d.temperature_2m_min[k];
      if (typeof hi === "number") highs.push(hi);
      if (typeof lo === "number") lows.push(lo);
      if ((d.precipitation_sum[k] ?? 0) >= RAINY_INCHES) rainy++;
      any ||= typeof hi === "number";
    }
    if (any) {
      rainyPerYear.push(rainy);
      used.push(Number(spans[i]!.s.slice(0, 4)));
    }
  });
  if (highs.length === 0 || lows.length === 0) throw new WeatherError("invalid_response", "no archive data for those dates");
  return {
    kind: "usually",
    start,
    end,
    highF: Math.round(avg(highs)),
    lowF: Math.round(avg(lows)),
    maxHighF: Math.round(Math.max(...highs)),
    minLowF: Math.round(Math.min(...lows)),
    rainyDays: Math.round(avg(rainyPerYear)),
    days: dayCount(start, end),
    years: used,
  };
}

const dayCount = (start: string, end: string) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;

/** Summarize forecast days that fall inside the range; null if none do. */
export function forecastOutlook(days: DailyForecast[], start: string, end: string): WeatherOutlook | null {
  const inRange = days.filter((d) => d.day >= start && d.day <= end);
  const highs = inRange.map((d) => d.tempMaxF).filter((x): x is number => x !== null);
  const lows = inRange.map((d) => d.tempMinF).filter((x): x is number => x !== null);
  if (highs.length === 0 || lows.length === 0) return null;
  const wet = inRange.filter((d) => isWet(classify(d.weatherCode, d.precipProbability)) && (d.precipProbability === null || d.precipProbability >= RAINY_PCT)).map((d) => d.day);
  return {
    kind: "forecast",
    start: inRange[0]!.day,
    end: inRange[inRange.length - 1]!.day,
    highF: Math.round(avg(highs)),
    lowF: Math.round(avg(lows)),
    maxHighF: Math.round(Math.max(...highs)),
    minLowF: Math.round(Math.min(...lows)),
    rainyDays: wet.length,
    days: inRange.length,
    wetDays: wet,
  };
}

/** The forecast when the trip is close enough (most of it inside the trusted window), else "usually". */
export async function outlook(lat: number, lon: number, start: string, end: string, today: string, deps: OpenMeteoDeps): Promise<WeatherOutlook> {
  const horizon = addDays(today, FORECAST_TRUST_DAYS - 1);
  const from = start < today ? today : start;
  if (from <= end && from <= horizon) {
    const covered = dayCount(from, end < horizon ? end : horizon);
    if (covered * 2 >= dayCount(from, end)) {
      const f = forecastOutlook(await fetchDailyForecast(lat, lon, deps), from, end < horizon ? end : horizon);
      if (f) return f;
    }
  }
  return climatology(lat, lon, start, end, today, deps);
}

// ---------- words ----------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const md = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

export function rangeWords(start: string, end: string): string {
  if (start === end) return md(start);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${md(start)}–${Number(end.slice(8, 10))}`;
  return `${md(start)} – ${md(end)}`;
}

function rainWords(o: WeatherOutlook): string {
  if (o.kind === "forecast") {
    if (o.rainyDays === 0) return "looks dry";
    if (o.rainyDays === o.days && o.days > 1) return "wet most days";
    const names = (o.wetDays ?? []).map((d) => WEEK[new Date(`${d}T12:00:00Z`).getUTCDay()]!);
    return names.length <= 2 ? `rain likely ${names.join(" and ")}` : `rain likely ${names.length} of the ${o.days} days`;
  }
  if (o.rainyDays === 0) return "usually dry";
  if (o.rainyDays === 1) return "maybe a rainy day";
  if (o.rainyDays <= 3) return "a couple rainy days";
  return `rain on about ${o.rainyDays} of the ${o.days} days`;
}

function packWords(o: WeatherOutlook): string {
  const tips: string[] = [];
  if (o.minLowF <= 32 || o.lowF <= 35) tips.push("pack layers and a warm coat");
  else if (o.highF <= 62) tips.push("pack layers");
  else if (o.highF >= 88) tips.push("pack light, it'll be hot");
  if (o.rainyDays >= 2 || (o.kind === "forecast" && o.rainyDays >= 1)) tips.push(tips.length ? "a rain jacket" : "bring a rain jacket");
  return tips.join(" + ");
}

/** "asheville, dec 16–23 (usually): highs ~50°, lows ~30°, a couple rainy days. pack layers" */
export function outlookBubble(place: string, o: WeatherOutlook): string {
  const label = o.kind === "forecast" ? "forecast" : "usually";
  const temps = o.kind === "forecast" && o.maxHighF - o.highF >= 4 ? `highs ${o.highF}–${o.maxHighF}°, lows ~${o.lowF}°` : `highs ~${o.highF}°, lows ~${o.lowF}°`;
  const pack = packWords(o);
  return `${place.split(",")[0]!.trim().toLowerCase()}, ${rangeWords(o.start, o.end)} (${label}): ${temps}, ${rainWords(o)}${pack ? `. ${pack}` : ""}`;
}
