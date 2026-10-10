// Deterministic day-by-day draft from a destination's activity list: 1–2 things a day ranked by
// group interests, long outdoor days spread apart, mobility and daily budget respected.
import { addDays, daysBetween } from "../clock.ts";
import { normalizeTag, type Activity, type Destination, type Setting, type Tag } from "./catalog.ts";

export interface ItineraryItem {
  activityId: string;
  name: string;
  setting: Setting;
  costCents: number;
  tags: Tag[];
  durationHours: number;
}

export interface ItineraryDay {
  date: string;
  items: ItineraryItem[];
}

export interface ItineraryOptions {
  mobility?: "low" | "normal";
  dailyActivityBudgetCents?: number;
}

/** Hours of planned activity on a full day. */
const FULL_DAY_HOURS = 9;
/** Arrival and departure days only get one short thing. */
const TRAVEL_DAY_HOURS = 4;
/** Anything this long fills the day on its own. */
const ALL_DAY_HOURS = 6;
const MAX_DAYS = 30;

function isHeavy(a: Activity): boolean {
  return a.setting === "outdoor" && (a.durationHours >= 4 || a.mobility === "strenuous");
}

/** Repeatable without anyone minding: another beach or chill day. */
function isRepeatable(a: Activity): boolean {
  return a.tags.includes("beach") || a.tags.includes("relaxing");
}

function interestWeights(interests: Record<string, number>): Map<string, number> {
  const weights = new Map<string, number>();
  for (const [key, weight] of Object.entries(interests)) {
    if (!Number.isFinite(weight)) continue;
    const tag = normalizeTag(key) ?? key.toLowerCase();
    weights.set(tag, Math.max(weights.get(tag) ?? Number.NEGATIVE_INFINITY, weight));
  }
  return weights;
}

function toItem(a: Activity): ItineraryItem {
  return { activityId: a.id, name: a.name, setting: a.setting, costCents: a.costCents, tags: a.tags, durationHours: a.durationHours };
}

/** Morning first: outdoor before indoor, nightlife last. */
function dayOrder(a: Activity, b: Activity): number {
  const rank = (x: Activity): number => (x.tags.includes("nightlife") ? 2 : x.setting === "outdoor" ? 0 : 1);
  return rank(a) - rank(b);
}

export function draftItinerary(
  dest: Destination,
  start: string,
  end: string,
  interests: Record<string, number>,
  opts: ItineraryOptions = {},
): ItineraryDay[] {
  const span = daysBetween(start, end);
  if (!Number.isFinite(span) || span < 0) return [];
  const dayCount = Math.min(span + 1, MAX_DAYS);
  const budget = opts.dailyActivityBudgetCents;
  const weights = interestWeights(interests);

  const eligible = dest.activities.filter(
    (a) => (opts.mobility !== "low" || a.mobility === "easy") && (budget === undefined || a.costCents <= budget),
  );
  const scoreOf = new Map(eligible.map((a) => [a.id, a.tags.reduce((sum, t) => sum + (weights.get(t) ?? 0), 0)]));
  const ranked = [...eligible].sort((a, b) => scoreOf.get(b.id)! - scoreOf.get(a.id)! || eligible.indexOf(a) - eligible.indexOf(b));

  const used = new Set<string>();
  const days: ItineraryDay[] = [];
  let previous: Activity[] = [];

  for (let i = 0; i < dayCount; i++) {
    const travelDay = dayCount > 1 && (i === 0 || i === dayCount - 1);
    const hoursLeft = travelDay ? TRAVEL_DAY_HOURS : FULL_DAY_HOURS;
    const slots = travelDay ? 1 : 2;
    const yesterdayHeavy = previous.some(isHeavy);
    const yesterday = new Set(previous.map((a) => a.id));

    const fits = (a: Activity, hours: number, cents: number | undefined): boolean =>
      a.durationHours <= hours && (cents === undefined || a.costCents <= cents);
    let pool = ranked.filter((a) => !used.has(a.id));
    if (!pool.some((a) => fits(a, hoursLeft, budget))) {
      // Ran out of new things: allow another beach/chill day, never the same as yesterday.
      pool = ranked.filter((a) => isRepeatable(a) && !yesterday.has(a.id));
    }

    const chosen: Activity[] = [];
    let hours = hoursLeft;
    let cents = budget;
    for (let slot = 0; slot < slots; slot++) {
      // At most one long outdoor thing a day, and none as an add-on the day after one.
      const noMoreHeavy = chosen.some(isHeavy) || (yesterdayHeavy && chosen.length > 0);
      const candidates = pool.filter((a) => !chosen.includes(a) && fits(a, hours, cents) && !(noMoreHeavy && isHeavy(a)));
      if (candidates.length === 0) break;
      // Spread long outdoor days: after one, lead with the best lighter option if there is one.
      const pick = (yesterdayHeavy || chosen.length > 0 ? candidates.find((a) => !isHeavy(a)) : undefined) ?? candidates[0]!;
      chosen.push(pick);
      hours -= pick.durationHours;
      if (cents !== undefined) cents -= pick.costCents;
      if (pick.durationHours >= ALL_DAY_HOURS) break;
    }

    for (const a of chosen) used.add(a.id);
    chosen.sort(dayOrder);
    days.push({ date: addDays(start, i), items: chosen.map(toItem) });
    previous = chosen;
  }
  return days;
}
