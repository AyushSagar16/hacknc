// Soft scoring and top-three selection: explainable, deterministic, diverse, budget-aware.
import { describe, expect, it } from "vitest";
import { destinations, findDestination, type Destination, type Region } from "../../src/trips/catalog.ts";
import type { CostBreakdown } from "../../src/trips/estimate.ts";
import { hardFilter, type GroupConstraints, type MemberConstraints, type Passed } from "../../src/trips/filter.ts";
import { pickThree, scoreDestinations, type MemberPrefs, type Scored } from "../../src/trips/score.ts";

const members: MemberConstraints[] = [
  { personId: 1, name: "maya", homeAirport: "RDU", dietary: [], vetoes: [] },
  { personId: 2, name: "leo", homeAirport: "CLT", dietary: [], vetoes: [] },
  { personId: 3, name: "priya", homeAirport: "JFK", dietary: [], vetoes: [] },
];
const g: GroupConstraints = { members, nights: 4, tier: "budget" };
const noPrefs = (personId: number): MemberPrefs => ({ personId, likesTags: [], namedDestinations: [], dislikesTags: [] });

function dest(id: string): Destination {
  const d = findDestination(id);
  if (!d) throw new Error(`no destination ${id}`);
  return d;
}

function clone(base: Destination, id: string, name: string, region?: Region): Destination {
  return { ...base, id, name, aliases: [], region: region ?? base.region };
}

function breakdown(totalCents: number): CostBreakdown {
  const e = { kind: "estimate" as const, detail: "test" };
  return {
    transportCents: totalCents, transportMode: "flight", lodgingCents: 0, foodCents: 0, activitiesCents: 0, localCents: 0,
    totalCents, sources: { transport: e, lodging: e, food: e, activities: e, local: e },
  };
}

function passedFor(list: Destination[], group = g): Passed[] {
  return hardFilter(list, group).passed;
}

function fakeScored(id: string, region: Region, score: number, costCents: number): Scored {
  return { dest: clone(dest("charleston"), id, id, region), score, reasons: [], perPerson: new Map([[1, breakdown(costCents)]]) };
}

describe("scoreDestinations", () => {
  it("a named destination wins an otherwise exact tie", () => {
    const alpha = clone(dest("charleston"), "alpha", "Alpha");
    const beta = clone(dest("charleston"), "beta", "Beta");
    const plain = scoreDestinations(passedFor([alpha, beta]), g, members.map((m) => noPrefs(m.personId)));
    expect(plain.map((s) => s.dest.id)).toEqual(["alpha", "beta"]);
    expect(plain[0]!.score).toBe(plain[1]!.score);

    const prefs = [noPrefs(1), noPrefs(2), { ...noPrefs(3), namedDestinations: ["Beta"] }];
    const named = scoreDestinations(passedFor([alpha, beta]), g, prefs);
    expect(named.map((s) => s.dest.id)).toEqual(["beta", "alpha"]);
    expect(named[0]!.score - named[1]!.score).toBeCloseTo(3);
    expect(named[0]!.reasons[0]).toBe("priya named it");
  });

  it("resolves named places through aliases and credits each person", () => {
    const prefs = [
      { ...noPrefs(1), namedDestinations: ["puerto rico"] },
      { ...noPrefs(2), namedDestinations: ["San Juan"] },
      noPrefs(3),
    ];
    const [top] = scoreDestinations(passedFor([dest("san-juan"), dest("charleston")]), g, prefs);
    expect(top!.dest.id).toBe("san-juan");
    expect(top!.reasons).toContain("maya and leo named it");
  });

  it("explains tag matches by person and penalizes dislikes", () => {
    const prefs: MemberPrefs[] = [
      { personId: 1, likesTags: ["beach", "food"], namedDestinations: [], dislikesTags: [] },
      { personId: 2, likesTags: ["beaches"], namedDestinations: [], dislikesTags: [] },
      { personId: 3, likesTags: [], namedDestinations: [], dislikesTags: ["nightlife"] },
    ];
    const scored = scoreDestinations(passedFor([dest("miami"), dest("asheville")]), g, prefs);
    const miami = scored.find((s) => s.dest.id === "miami")!;
    expect(miami.reasons).toContain("beach for maya and leo");
    expect(miami.reasons).toContain("food for maya");
    expect(miami.reasons).toContain("priya isn't into nightlife");
    expect(miami.reasons.indexOf("beach for maya and leo")).toBeLessThan(miami.reasons.indexOf("priya isn't into nightlife"));

    const without = scoreDestinations(passedFor([dest("miami")]), g, prefs.slice(0, 2));
    expect(miami.score).toBeCloseTo(without[0]!.score - 1.5);
  });

  it("rewards a great month and budget headroom", () => {
    const passed = passedFor([dest("charleston")]);
    const base = scoreDestinations(passed, g, [], 7)[0]!;
    const april = scoreDestinations(passed, g, [], 4)[0]!;
    expect(april.score - base.score).toBeCloseTo(1);
    expect(april.reasons).toContain("great in April");

    const roomy: GroupConstraints = { ...g, members: members.map((m) => ({ ...m, budgetCeilingCents: 500_000 })) };
    const withCeilings = scoreDestinations(passedFor([dest("charleston")], roomy), roomy, [], 7)[0]!;
    expect(withCeilings.score).toBeGreaterThan(base.score);
    expect(withCeilings.reasons).toContain("comfortably under everyone's budget");
  });

  it("mildly prefers the cheaper of two otherwise identical places", () => {
    const cheap = clone(dest("myrtle-beach"), "cheap", "Cheap");
    const pricey = { ...clone(dest("myrtle-beach"), "pricey", "Pricey"), costs: { ...dest("key-west").costs } };
    const scored = scoreDestinations(passedFor([pricey, cheap]), g, []);
    expect(scored.map((s) => s.dest.id)).toEqual(["cheap", "pricey"]);
    expect(scored[0]!.score - scored[1]!.score).toBeLessThan(1);
  });

  it("is deterministic regardless of input order", () => {
    const prefs: MemberPrefs[] = [
      { personId: 1, likesTags: ["beach"], namedDestinations: ["tulum"], dislikesTags: [] },
      { personId: 2, likesTags: ["nightlife", "food"], namedDestinations: [], dislikesTags: ["snow"] },
      { personId: 3, likesTags: ["culture"], namedDestinations: [], dislikesTags: [] },
    ];
    const passed = passedFor(destinations());
    const a = scoreDestinations(passed, g, prefs, 3);
    const b = scoreDestinations([...passed].reverse(), g, prefs, 3);
    expect(b.map((s) => [s.dest.id, s.score, s.reasons])).toEqual(a.map((s) => [s.dest.id, s.score, s.reasons]));
    expect(pickThree(b).map((s) => s.dest.id)).toEqual(pickThree(a).map((s) => s.dest.id));
    expect(a[0]!.dest.id).toBe("tulum");
  });
});

describe("pickThree", () => {
  it("returns everything (sorted) when there are three or fewer", () => {
    const list = [fakeScored("b", "europe", 1, 100_000), fakeScored("a", "mexico", 2, 100_000)];
    expect(pickThree(list).map((s) => s.dest.id)).toEqual(["a", "b"]);
  });

  it("avoids three from one region when a close alternative exists", () => {
    const list = [
      fakeScored("se1", "southeast_us", 10, 60_000),
      fakeScored("se2", "southeast_us", 9.8, 60_000),
      fakeScored("se3", "southeast_us", 9.5, 60_000),
      fakeScored("mx1", "mexico", 8.2, 60_000),
      fakeScored("se4", "southeast_us", 9.4, 60_000),
    ];
    expect(pickThree(list).map((s) => s.dest.id)).toEqual(["se1", "se2", "mx1"]);
  });

  it("keeps three from one region when the alternative is much worse", () => {
    const list = [
      fakeScored("se1", "southeast_us", 10, 60_000),
      fakeScored("se2", "southeast_us", 9.8, 60_000),
      fakeScored("se3", "southeast_us", 9.5, 60_000),
      fakeScored("mx1", "mexico", 5, 60_000),
    ];
    expect(pickThree(list).map((s) => s.dest.id)).toEqual(["se1", "se2", "se3"]);
  });

  it("swaps in a cheaper option when all three are pricey", () => {
    const list = [
      fakeScored("lux1", "europe", 10, 250_000),
      fakeScored("lux2", "caribbean", 9.6, 240_000),
      fakeScored("lux3", "hawaii", 9.2, 260_000),
      fakeScored("cheap", "southeast_us", 7.5, 60_000),
      fakeScored("cheap2", "southeast_us", 7.0, 55_000),
      fakeScored("cheap3", "midwest_us", 3, 50_000),
    ];
    expect(pickThree(list).map((s) => s.dest.id)).toEqual(["lux1", "lux2", "cheap"]);
  });

  it("leaves a pricey top three alone when cheaper options score far lower", () => {
    const list = [
      fakeScored("lux1", "europe", 10, 250_000),
      fakeScored("lux2", "caribbean", 9.6, 240_000),
      fakeScored("lux3", "hawaii", 9.2, 260_000),
      fakeScored("cheap", "southeast_us", 4, 60_000),
      fakeScored("cheap2", "midwest_us", 3, 50_000),
    ];
    expect(pickThree(list).map((s) => s.dest.id)).toEqual(["lux1", "lux2", "lux3"]);
  });
});
