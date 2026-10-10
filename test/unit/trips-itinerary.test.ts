// Itinerary drafts: one per day, 1–2 items, deterministic, spread-out long outdoor days,
// mobility and daily budget respected.
import { describe, expect, it } from "vitest";
import { addDays } from "../../src/clock.ts";
import { destinations, findDestination, type Activity, type Destination } from "../../src/trips/catalog.ts";
import { draftItinerary } from "../../src/trips/itinerary.ts";

function dest(id: string): Destination {
  const d = findDestination(id);
  if (!d) throw new Error(`no destination ${id}`);
  return d;
}

const byId = (d: Destination): Map<string, Activity> => new Map(d.activities.map((a) => [a.id, a]));
const heavy = (a: Activity): boolean => a.setting === "outdoor" && (a.durationHours >= 4 || a.mobility === "strenuous");

describe("draftItinerary", () => {
  it("covers every date from start to end with 1–2 distinct activities", () => {
    const d = dest("san-juan");
    const days = draftItinerary(d, "2027-03-06", "2027-03-10", { beach: 2, food: 1.5, nightlife: 1 });
    expect(days.map((x) => x.date)).toEqual([0, 1, 2, 3, 4].map((i) => addDays("2027-03-06", i)));
    for (const day of days) {
      expect(day.items.length).toBeGreaterThanOrEqual(1);
      expect(day.items.length).toBeLessThanOrEqual(2);
    }
    // Arrival and departure days are light.
    expect(days[0]!.items).toHaveLength(1);
    expect(days[4]!.items).toHaveLength(1);
    const ids = days.flatMap((x) => x.items.map((i) => i.activityId));
    expect(new Set(ids).size).toBe(ids.length);
    const known = byId(d);
    for (const item of days.flatMap((x) => x.items)) {
      const a = known.get(item.activityId)!;
      expect(item).toMatchObject({ name: a.name, setting: a.setting, costCents: a.costCents });
    }
  });

  it("is deterministic", () => {
    const d = dest("asheville");
    const a = draftItinerary(d, "2027-05-01", "2027-05-04", { hiking: 2, food: 1 });
    const b = draftItinerary(d, "2027-05-01", "2027-05-04", { hiking: 2, food: 1 });
    expect(b).toEqual(a);
  });

  it("follows the group's interests", () => {
    const d = dest("miami");
    const foodies = draftItinerary(d, "2027-02-10", "2027-02-13", { food: 3 }).flatMap((x) => x.items);
    expect(foodies.filter((i) => i.tags.includes("food")).length).toBeGreaterThanOrEqual(2);
    const beachy = draftItinerary(d, "2027-02-10", "2027-02-13", { beach: 3 }).flatMap((x) => x.items);
    expect(beachy.some((i) => i.activityId === "miami-south-beach")).toBe(true);
  });

  it("doesn't stack long outdoor days back to back when there are lighter options", () => {
    for (const d of destinations()) {
      const days = draftItinerary(d, "2027-04-01", "2027-04-06", { outdoors: 2, hiking: 2, adventure: 2, beach: 2 });
      const known = byId(d);
      for (let i = 1; i < days.length; i++) {
        const today = days[i]!.items.map((x) => known.get(x.activityId)!);
        const yesterday = days[i - 1]!.items.map((x) => known.get(x.activityId)!);
        if (today.some(heavy) && yesterday.some(heavy)) {
          // Only as the day's sole item, and only when nothing light that fits was left.
          expect(today, `${d.id} ${days[i]!.date}`).toHaveLength(1);
          const usedBefore = new Set(days.slice(0, i).flatMap((x) => x.items.map((it) => it.activityId)));
          const lightLeft = d.activities.filter((a) => !heavy(a) && !usedBefore.has(a.id) && a.durationHours <= 4);
          expect(lightLeft.length, `${d.id} ${days[i]!.date}`).toBe(0);
        }
        expect(today.filter(heavy).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("only easy activities for low mobility", () => {
    const d = dest("gatlinburg");
    const known = byId(d);
    const days = draftItinerary(d, "2027-10-01", "2027-10-04", { hiking: 3, adventure: 2 }, { mobility: "low" });
    const items = days.flatMap((x) => x.items);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(known.get(item.activityId)!.mobility).toBe("easy");
  });

  it("keeps each day within the activity budget", () => {
    const budget = 3_000;
    for (const id of ["new-york", "reykjavik", "cancun", "las-vegas"]) {
      const days = draftItinerary(dest(id), "2027-06-01", "2027-06-04", { culture: 1, food: 1, adventure: 1 }, { dailyActivityBudgetCents: budget });
      for (const day of days) {
        expect(day.items.reduce((sum, i) => sum + i.costCents, 0), `${id} ${day.date}`).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("handles single-day, long and backwards trips", () => {
    const d = dest("charleston");
    const single = draftItinerary(d, "2027-04-10", "2027-04-10", { food: 1 });
    expect(single).toHaveLength(1);
    expect(single[0]!.items.length).toBeGreaterThanOrEqual(1);

    const long = draftItinerary(d, "2027-04-01", "2027-04-10", { beach: 1 });
    expect(long).toHaveLength(10);
    const ids = long.flatMap((x) => x.items.map((i) => i.activityId));
    const repeats = ids.filter((id, i) => ids.indexOf(id) !== i);
    const known = byId(d);
    for (const id of repeats) {
      const a = known.get(id)!;
      expect(a.tags.includes("beach") || a.tags.includes("relaxing")).toBe(true);
    }

    expect(draftItinerary(d, "2027-04-10", "2027-04-01", {})).toEqual([]);
  });
});
