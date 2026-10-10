import { describe, expect, it } from "vitest";
import { aggregate, supersededFacts } from "../../src/profile/aggregate.ts";
import { groupView, pickDates } from "../../src/profile/groupView.ts";
import type { Fact } from "../../src/profile/schema.ts";

let nextId = 1;
const t0 = Date.parse("2026-10-10T15:00:00Z");
const fact = (over: Partial<Fact> & Pick<Fact, "key" | "value">, minutesLater = 0): Fact => ({
  id: nextId++,
  personId: 1,
  polarity: "positive",
  explicit: true,
  confidence: 0.9,
  visibility: "public",
  sourceMessageId: null,
  quote: null,
  observedAt: new Date(t0 + minutesLater * 60_000),
  retracted: false,
  ...over,
});

describe("aggregate", () => {
  it("ignores facts under the confidence floor", () => {
    const p = aggregate(1, [fact({ key: "dietary", value: { need: "vegan" }, confidence: 0.4 })]);
    expect(p.dietary).toEqual([]);
  });

  it("newest explicit statement wins a single-valued slot", () => {
    const p = aggregate(1, [
      fact({ key: "home_city", value: { city: "Raleigh" } }, 0),
      fact({ key: "home_city", value: { city: "Charlotte" } }, 5),
    ]);
    expect(p.homeCity?.value).toBe("Charlotte");
  });

  it("a later implied fact does not override an earlier explicit one", () => {
    const p = aggregate(1, [
      fact({ key: "date_window", value: { latest: "2026-11-14" }, explicit: true }, 0),
      fact({ key: "date_window", value: { latest: "2026-11-20" }, explicit: false }, 10),
    ]);
    expect(p.latest?.value).toBe("2026-11-14");
  });

  it("a later explicit retraction replaces an earlier date limit", () => {
    const p = aggregate(1, [
      fact({ key: "date_window", value: { latest: "2026-11-14" }, quote: "i can't fly after the 14th" }, 0),
      fact({ key: "date_window", value: { latest: "2026-11-15" }, retracted: true, quote: "actually i can do the 15th" }, 30),
    ]);
    expect(p.latest).toMatchObject({ value: "2026-11-15", quote: "actually i can do the 15th" });
  });

  it("keeps earliest and latest as separate slots", () => {
    const p = aggregate(1, [
      fact({ key: "date_window", value: { earliest: "2026-11-10", latest: null } }, 0),
      fact({ key: "date_window", value: { earliest: null, latest: "2026-11-16" } }, 1),
    ]);
    expect([p.earliest?.value, p.latest?.value]).toEqual(["2026-11-10", "2026-11-16"]);
  });

  it("tracks a veto, then clears it when the person comes around (neutral)", () => {
    const veto = aggregate(1, [fact({ key: "destination", value: { name: "Cancún" }, polarity: "negative", quote: "cancun is too pricey for me" })]);
    expect(veto.vetoes.map((v) => v.value)).toEqual(["Cancún"]);
    const cleared = aggregate(1, [
      fact({ key: "destination", value: { name: "Cancún" }, polarity: "negative" }, 0),
      fact({ key: "destination", value: { name: "cancun" }, polarity: "neutral", quote: "ok i'm fine with cancun" }, 20),
    ]);
    expect(cleared.vetoes).toEqual([]);
    expect(cleared.wants).toEqual([]);
  });

  it("flips a veto into a want when they change their mind", () => {
    const p = aggregate(1, [
      fact({ key: "destination", value: { name: "Lisbon" }, polarity: "negative" }, 0),
      fact({ key: "destination", value: { name: "lisbon" }, polarity: "positive", retracted: true }, 5),
    ]);
    expect(p.vetoes).toEqual([]);
    expect(p.wants.map((w) => w.value)).toEqual(["lisbon"]);
  });

  it("a retracted dietary need or travel limit is removed", () => {
    const p = aggregate(1, [
      fact({ key: "dietary", value: { need: "vegetarian" } }, 0),
      fact({ key: "travel_limit", value: { kind: "no_flying", hours: null } }, 1),
      fact({ key: "travel_limit", value: { kind: "no_flying", hours: null }, retracted: true }, 2),
    ]);
    expect(p.dietary.map((d) => d.value)).toEqual(["vegetarian"]);
    expect(p.travelLimits).toEqual([]);
  });

  it("collects many likes and dislikes and a budget ceiling", () => {
    const p = aggregate(1, [
      fact({ key: "activity", value: { tag: "beach" } }),
      fact({ key: "activity", value: { tag: "hiking" } }),
      fact({ key: "activity", value: { tag: "nightlife" }, polarity: "negative" }),
      fact({ key: "budget_comment", value: { kind: "ceiling", amountUsd: 600, about: null } }),
      fact({ key: "budget_comment", value: { kind: "too_expensive", amountUsd: null, about: "Cancun" } }),
    ]);
    expect(p.likes.map((l) => l.value).sort()).toEqual(["beach", "hiking"]);
    expect(p.dislikes.map((l) => l.value)).toEqual(["nightlife"]);
    expect(p.budgetCeilingUsd?.value).toBe(600);
    expect(p.tooExpensive.map((t) => t.value)).toEqual(["Cancun"]);
  });

  it("only uses the requested person's facts", () => {
    const p = aggregate(2, [fact({ key: "dietary", value: { need: "vegan" }, personId: 1 })]);
    expect(p.dietary).toEqual([]);
  });

  it("reports which facts were superseded", () => {
    const a = fact({ key: "home_city", value: { city: "Raleigh" } }, 0);
    const b = fact({ key: "home_city", value: { city: "Durham" } }, 1);
    expect(supersededFacts([a, b])).toEqual(new Map([[a.id, b.id]]));
  });
});

describe("groupView", () => {
  const member = (personId: number, label: string, facts: Fact[]) => ({ personId, label, profile: aggregate(personId, facts) });

  it("intersects date windows and finds missing info", () => {
    const view = groupView(
      [
        member(1, "Maya", [fact({ personId: 1, key: "date_window", value: { earliest: "2026-11-11", latest: "2026-11-20" } }), fact({ personId: 1, key: "home_city", value: { city: "Raleigh" } })]),
        member(2, "Leo", [fact({ personId: 2, key: "date_window", value: { earliest: null, latest: "2026-11-14" } })]),
        member(3, "Priya", []),
      ],
      "2026-10-10",
    );
    expect(view.window).toMatchObject({ earliest: "2026-11-11", latest: "2026-11-14", conflict: false });
    expect(view.dates).toEqual({ start: "2026-11-11", end: "2026-11-14", nights: 3 });
    expect(view.missing.map((m) => [m.label, m.fields])).toEqual([
      ["Leo", ["home_city"]],
      ["Priya", ["dates", "home_city"]],
    ]);
    expect(view.majorityHasShared).toBe(false); // only maya has shared everything
  });

  it("flags a conflict when windows don't overlap", () => {
    const view = groupView(
      [
        member(1, "Maya", [fact({ personId: 1, key: "date_window", value: { earliest: "2026-12-01", latest: null } })]),
        member(2, "Leo", [fact({ personId: 2, key: "date_window", value: { earliest: null, latest: "2026-11-20" } })]),
      ],
      "2026-10-10",
    );
    expect(view.window.conflict).toBe(true);
    expect(view.dates).toBeNull();
  });

  it("groups vetoes, wants, diets and likes by person", () => {
    const view = groupView(
      [
        member(1, "Maya", [fact({ personId: 1, key: "destination", value: { name: "Cancún" }, polarity: "negative" }), fact({ personId: 1, key: "dietary", value: { need: "vegetarian" } })]),
        member(2, "Leo", [fact({ personId: 2, key: "destination", value: { name: "cancun" }, polarity: "positive" }), fact({ personId: 2, key: "activity", value: { tag: "beach" } })]),
      ],
      "2026-10-10",
    );
    expect(view.vetoes.get("cancun")).toEqual({ name: "Cancún", people: ["Maya"] });
    expect(view.wants.get("cancun")?.people).toEqual(["Leo"]);
    expect(view.dietary.get("vegetarian")).toEqual(["Maya"]);
    expect(view.likes.get("beach")).toEqual(["Leo"]);
  });

  it("pickDates skips blackouts and shrinks to short windows", () => {
    expect(pickDates("2026-11-10", "2026-11-20", 4, [{ start: "2026-11-12", end: "2026-11-13" }])).toEqual({ start: "2026-11-14", end: "2026-11-18", nights: 4 });
    expect(pickDates("2026-11-10", "2026-11-12", 4, [])).toEqual({ start: "2026-11-10", end: "2026-11-12", nights: 2 });
    expect(pickDates("2026-11-10", "2026-11-12", 2, [{ start: "2026-11-09", end: "2026-11-30" }])).toBeNull();
  });
});
