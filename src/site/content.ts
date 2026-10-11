// Page content Atlas writes itself: the day-by-day plan and a short trip summary, as structured
// JSON from the agent's tool calls. Everything is validated here before it's saved, and the money
// rule holds on the page too: no dollar figures from the model (costs come from the catalog).
import { z } from "zod";
import { addDays, daysBetween } from "../clock.ts";
import type { Destination } from "../trips/catalog.ts";
import type { ItineraryDay } from "../trips/state.ts";

const MONEY = /[$€£]\s?\d|\d\s?(?:usd|dollars|bucks)\b/i;
const noMoney = (s: string) => !MONEY.test(s);
const MONEY_MSG = "leave prices out; costs on the page come from the catalog";

const text = (max: number) => z.string().trim().min(1).max(max).refine(noMoney, MONEY_MSG);

export const itineraryInput = z.object({
  days: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dates are YYYY-MM-DD"),
        title: text(60).optional(),
        items: z
          .array(
            z.object({
              name: text(80),
              time: z.string().trim().max(24).optional(),
              setting: z.enum(["outdoor", "indoor", "either"]).default("either"),
              notes: text(200).optional(),
            }),
          )
          .max(8, "at most 8 things a day"),
      }),
    )
    .min(1)
    .max(21),
});

export const summaryInput = z.object({
  summary: text(400),
  title: z.string().trim().min(1).max(40).refine(noMoney, MONEY_MSG).optional(),
});

/** First validation problem, phrased for the model to fix and retry. */
export function problem(err: z.ZodError): string {
  const issue = err.issues[0];
  return issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "invalid input";
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** A catalog activity the item names ("Biltmore Estate" → biltmore-estate), for its id, tags and cost. */
export function matchActivity(dest: Destination | undefined, name: string): Destination["activities"][number] | undefined {
  if (!dest) return undefined;
  const n = name.toLowerCase();
  return dest.activities.find((a) => a.name.toLowerCase() === n) ?? dest.activities.find((a) => n.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(n));
}

/**
 * Apply the agent's days to the plan: each given date is replaced whole, other days are kept, and
 * every date of the trip is present (empty if nothing's planned). Throws a message for the model.
 */
export function mergeItinerary(
  current: ItineraryDay[],
  input: z.infer<typeof itineraryInput>,
  trip: { start: string; end: string; dest?: Destination },
): ItineraryDay[] {
  const span = daysBetween(trip.start, trip.end);
  const byDate = new Map(current.map((d) => [d.date, d]));
  for (const day of input.days) {
    if (day.date < trip.start || day.date > trip.end) throw new Error(`${day.date} is outside the trip (${trip.start} to ${trip.end})`);
    byDate.set(day.date, {
      date: day.date,
      ...(day.title ? { title: day.title } : {}),
      items: day.items.map((item) => {
        const known = matchActivity(trip.dest, item.name);
        return {
          activityId: known?.id ?? `custom:${slug(item.name)}`,
          name: item.name,
          setting: item.setting === "either" && known ? known.setting : item.setting,
          costCents: known?.costCents ?? 0,
          ...(known ? { tags: [...known.tags] } : {}),
          ...(item.time ? { time: item.time } : {}),
          ...(item.notes ? { notes: item.notes } : {}),
        };
      }),
    });
  }
  return Array.from({ length: span + 1 }, (_, i) => addDays(trip.start, i)).map((date) => byDate.get(date) ?? { date, items: [] });
}

/** The plan as one chat bubble, for when there's no trip page to link. */
export function itineraryText(days: ItineraryDay[]): string {
  const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).toLowerCase();
  return `the plan:\n${days.map((d) => `${weekday(d.date)}: ${d.items.map((i) => i.name.toLowerCase()).join(", ") || "free day"}`).join("\n")}`;
}
