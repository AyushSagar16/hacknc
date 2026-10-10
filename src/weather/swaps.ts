// Turn a bad-weather change into one concrete fix for the group: swap the outdoor plan with an
// indoor one on a dry day, or replace it with the best-liked spare indoor activity within budget.
import { daysBetween } from "../clock.ts";
import { isDry } from "./classify.ts";
import { DETECT_DEFAULTS, weekdayName, type Change, type DaySnapshot } from "./diff.ts";

export type Setting = "outdoor" | "indoor" | "either";

export interface ItineraryItem {
  activityId: string;
  name: string;
  setting: Setting;
  costCents: number;
  tags?: string[];
}

export interface ItineraryDay {
  date: string;
  items: ItineraryItem[];
}

export interface SpareActivity {
  id: string;
  name: string;
  setting: Setting;
  costCents: number;
  tags: string[];
}

export interface SwapInput {
  change: Change;
  itinerary: ItineraryDay[];
  spareActivities: SpareActivity[];
  /** Group interest weights by tag, e.g. { food: 0.9, museums: 0.4 }. */
  interests: Record<string, number>;
  /** How much more than the outdoor item a replacement may cost. Default $25. */
  maxExtraCostCents?: number;
  forecastByDay: Map<string, DaySnapshot>;
  /** Days before this are never swap targets. */
  today?: string;
}

export interface SwapProposal {
  day: string;
  kind: "swap_days" | "replace";
  outdoor: { activityId: string; name: string; costCents: number };
  replacement: { activityId: string; name: string; costCents: number; fromDay?: string };
  message: string;
  pollOptions: [string, string];
}

export const DEFAULT_MAX_EXTRA_COST_CENTS = 2500;
/** Daily highs outside this band make a day bad for outdoor plans. */
export const COMFORT_LOW_F = 50;
export const COMFORT_HIGH_F = 95;

/** One proposal for the change's day, or null when nothing outdoor is affected or no fix exists. */
export function proposeSwap(input: SwapInput): SwapProposal | null {
  const { change } = input;
  if (!worthFixing(change)) return null;

  const affected = input.itinerary.find((d) => d.date === change.day);
  const outdoor = affected?.items.find((i) => i.setting === "outdoor");
  if (!outdoor) return null;
  const outdoorRef = { activityId: outdoor.activityId, name: outdoor.name, costCents: outdoor.costCents };

  const swap = bestDaySwap(input);
  if (swap) {
    const message = `${change.summary}. want to swap ${the(outdoor.name)} for ${the(swap.item.name)} on ${weekdayName(swap.date)}?`;
    return {
      day: change.day,
      kind: "swap_days",
      outdoor: outdoorRef,
      replacement: { activityId: swap.item.activityId, name: swap.item.name, costCents: swap.item.costCents, fromDay: swap.date },
      message: message.toLowerCase(),
      pollOptions: ["swap them", "keep the plan"],
    };
  }

  const spare = bestReplacement(input, outdoor);
  if (spare) {
    const delta = spare.costCents - outdoor.costCents;
    const cost = delta > 0 ? ` it's ${dollars(delta)} more` : delta < 0 ? ` it saves ${dollars(-delta)}` : "";
    const message = `${change.summary}. want to swap ${the(outdoor.name)} for ${the(spare.name)} instead?${cost}`;
    return {
      day: change.day,
      kind: "replace",
      outdoor: outdoorRef,
      replacement: { activityId: spare.id, name: spare.name, costCents: spare.costCents },
      message: message.toLowerCase(),
      pollOptions: ["swap it", "keep the plan"],
    };
  }

  return null;
}

/** Rain, storms and wind always threaten outdoor plans; a temp swing only when it leaves the comfort band. */
function worthFixing(change: Change): boolean {
  switch (change.kind) {
    case "turned_wet":
    case "storm":
    case "wind":
      return true;
    case "temp_swing":
      return !comfortable(change.to.tempMaxF);
    case "cleared_up":
      return false;
  }
}

function comfortable(tempMaxF: number | null): boolean {
  return tempMaxF === null || (tempMaxF >= COMFORT_LOW_F && tempMaxF < COMFORT_HIGH_F);
}

function goodOutdoorDay(s: DaySnapshot | undefined): s is DaySnapshot {
  return !!s && isDry(s.category) && (s.windGustMph ?? 0) < DETECT_DEFAULTS.gustMph && comfortable(s.tempMaxF);
}

/** Nearest good-weather day holding an indoor (then either) item; clearer skies break ties. */
function bestDaySwap(input: SwapInput): { date: string; item: ItineraryItem } | null {
  const target = input.change.day;
  const candidates: { date: string; item: ItineraryItem; rank: number[] }[] = [];
  for (const day of input.itinerary) {
    if (day.date === target || (input.today && day.date < input.today)) continue;
    const forecast = input.forecastByDay.get(day.date);
    if (!goodOutdoorDay(forecast)) continue;
    day.items.forEach((item, idx) => {
      if (item.setting === "outdoor") return;
      candidates.push({
        date: day.date,
        item,
        rank: [
          Math.abs(daysBetween(target, day.date)),
          item.setting === "indoor" ? 0 : 1,
          forecast.category === "clear" ? 0 : 1,
          daysBetween(target, day.date) < 0 ? 0 : 1,
          idx,
        ],
      });
    });
  }
  candidates.sort((a, b) => compareRanks(a.rank, b.rank));
  return candidates[0] ?? null;
}

/** Highest interest score among rain-safe spares within budget; indoor, then cheaper, then name. */
function bestReplacement(input: SwapInput, outdoor: ItineraryItem): SpareActivity | null {
  const budget = outdoor.costCents + (input.maxExtraCostCents ?? DEFAULT_MAX_EXTRA_COST_CENTS);
  const planned = new Set(input.itinerary.flatMap((d) => d.items.map((i) => i.activityId)));
  const score = (a: SpareActivity) => a.tags.reduce((sum, tag) => sum + (input.interests[tag] ?? 0), 0);

  const candidates = input.spareActivities.filter(
    (a) => a.setting !== "outdoor" && a.costCents <= budget && !planned.has(a.id),
  );
  candidates.sort(
    (a, b) =>
      score(b) - score(a) ||
      (a.setting === "indoor" ? 0 : 1) - (b.setting === "indoor" ? 0 : 1) ||
      a.costCents - b.costCents ||
      a.name.localeCompare(b.name),
  );
  return candidates[0] ?? null;
}

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** "beach day" -> "the beach day"; leaves names that already start with an article alone. */
function the(name: string): string {
  const n = name.trim().toLowerCase();
  return /^(the|a|an) /.test(n) ? n : `the ${n}`;
}

function dollars(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}
