// Material forecast changes per trip day between the last-seen snapshot and a fresh one,
// each with a severity and a lowercase chat summary ("saturday flipped to rain (70%)").
import { classify, describe, isDry, isWet, type WeatherCategory } from "./classify.ts";
import type { DailyForecast } from "./openMeteo.ts";

export interface DaySnapshot {
  day: string;
  category: WeatherCategory;
  precipProbability: number | null;
  tempMaxF: number | null;
  windGustMph: number | null;
}

export type ChangeKind = "turned_wet" | "storm" | "temp_swing" | "wind" | "cleared_up";
export type Severity = 1 | 2 | 3;

export interface Change {
  day: string;
  kind: ChangeKind;
  from: DaySnapshot | null;
  to: DaySnapshot;
  severity: Severity;
  summary: string;
}

export interface DetectOptions {
  /** Precip % at which a rain/snow day counts as wet (default 50). */
  wetPrecipPct?: number;
  /** Precip % a day needs to be reported when we have never seen it before (default 60). */
  firstLookPrecipPct?: number;
  /** Absolute change in daily high that counts as a swing (default 12°F). */
  tempSwingF?: number;
  /** Gust speed that counts as windy (default 40 mph). */
  gustMph?: number;
}

export const DETECT_DEFAULTS: Required<DetectOptions> = {
  wetPrecipPct: 50,
  firstLookPrecipPct: 60,
  tempSwingF: 12,
  gustMph: 40,
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** "2026-10-17" -> "saturday". */
export function weekdayName(day: string): string {
  return WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()] ?? day;
}

export function toSnapshot(f: DailyForecast): DaySnapshot {
  return {
    day: f.day,
    category: classify(f.weatherCode, f.precipProbability),
    precipProbability: f.precipProbability,
    tempMaxF: f.tempMaxF,
    windGustMph: f.windGustMph,
  };
}

/** Snapshot map keyed by day, optionally limited to the given (trip) days. */
export function snapshotsFromForecast(forecast: DailyForecast[], days?: Iterable<string>): Map<string, DaySnapshot> {
  const keep = days ? new Set(days) : null;
  const out = new Map<string, DaySnapshot>();
  for (const f of forecast) if (!keep || keep.has(f.day)) out.set(f.day, toSnapshot(f));
  return out;
}

/**
 * Changes worth telling the group about, sorted by day then severity (highest first).
 * A day missing from `prev` (first fetch, or newly inside the 16-day window) is only
 * reported if it is already bad: storm or rain/snow at >= firstLookPrecipPct.
 */
export function detectChanges(
  prev: Map<string, DaySnapshot>,
  next: Map<string, DaySnapshot>,
  opts: DetectOptions = {},
): Change[] {
  const o = { ...DETECT_DEFAULTS, ...opts };
  const changes: Change[] = [];

  for (const day of [...next.keys()].sort()) {
    const to = next.get(day)!;
    const from = prev.get(day) ?? null;
    const wd = weekdayName(day);
    const push = (kind: ChangeKind, severity: Severity, summary: string) =>
      changes.push({ day, kind, from, to, severity, summary });

    if (!from) {
      if ((to.precipProbability ?? -1) < o.firstLookPrecipPct) continue;
      if (to.category === "storm") push("storm", 3, `${wd}'s forecast shows thunderstorms${pct(to)}`);
      else if (isWet(to.category)) push("turned_wet", 2, `${wd}'s forecast shows ${to.category}${pct(to)}`);
      continue;
    }

    // Wet/dry dimension: at most one change per day.
    if (to.category === "storm" && from.category !== "storm") {
      const verb = isDry(from.category) ? "flipped to" : "escalated to";
      push("storm", 3, `${wd} ${verb} thunderstorms${pct(to)}`);
    } else if (!materiallyWet(from, o.wetPrecipPct) && materiallyWet(to, o.wetPrecipPct)) {
      push(
        "turned_wet",
        2,
        isDry(from.category)
          ? `${wd} flipped to ${to.category}${pct(to)}`
          : `${wd}'s ${to.category} chance jumped to ${to.precipProbability}%`,
      );
    } else if (materiallyWet(from, o.wetPrecipPct) && isDry(to.category)) {
      push("cleared_up", 1, `${wd} cleared up (${describe(to.category, to.tempMaxF)})`);
    }

    if (from.tempMaxF !== null && to.tempMaxF !== null && Math.abs(to.tempMaxF - from.tempMaxF) >= o.tempSwingF) {
      const verb = to.tempMaxF > from.tempMaxF ? "jumped" : "dropped";
      push("temp_swing", 1, `${wd} ${verb} to ${Math.round(to.tempMaxF)}° (was ${Math.round(from.tempMaxF)}°)`);
    }

    if ((to.windGustMph ?? 0) >= o.gustMph && (from.windGustMph ?? 0) < o.gustMph) {
      push("wind", 2, `${wd} gusts up to ${Math.round(to.windGustMph!)} mph`);
    }
  }

  return changes.sort((a, b) => (a.day === b.day ? b.severity - a.severity : a.day < b.day ? -1 : 1));
}

/** Storms always count; rain/snow only with a known probability at or above the threshold. */
function materiallyWet(s: DaySnapshot, wetPrecipPct: number): boolean {
  if (s.category === "storm") return true;
  return isWet(s.category) && (s.precipProbability ?? -1) >= wetPrecipPct;
}

function pct(s: DaySnapshot): string {
  return s.precipProbability === null ? "" : ` (${Math.round(s.precipProbability)}%)`;
}
