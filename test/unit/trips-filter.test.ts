// Hard constraints: each rule rejects with a reason that names the person it protects.
import { describe, expect, it } from "vitest";
import { destinations, findDestination, type Destination } from "../../src/trips/catalog.ts";
import { estimateCost } from "../../src/trips/estimate.ts";
import { hardFilter, tripMonths, vetoMatch, type GroupConstraints, type MemberConstraints } from "../../src/trips/filter.ts";

const catalog = destinations();

function member(overrides: Partial<MemberConstraints> & { personId: number; name: string }): MemberConstraints {
  return { homeAirport: "RDU", dietary: [], vetoes: [], ...overrides };
}

function group(members: MemberConstraints[], extra: Partial<GroupConstraints> = {}): GroupConstraints {
  return { members, nights: 4, tier: "budget", ...extra };
}

function dest(id: string): Destination {
  const d = findDestination(id);
  if (!d) throw new Error(`no destination ${id}`);
  return d;
}

const ids = (list: { dest: Destination }[]): string[] => list.map((p) => p.dest.id);
const reasonsFor = (rejected: { destinationId: string; reason: string }[], id: string): string[] =>
  rejected.filter((r) => r.destinationId === id).map((r) => r.reason);

describe("hardFilter", () => {
  it("passes everything for an unconstrained group and prices every member", () => {
    const g = group([member({ personId: 1, name: "maya" }), member({ personId: 2, name: "leo", homeAirport: "JFK" })]);
    const { passed, rejected } = hardFilter(catalog, g);
    expect(rejected).toEqual([]);
    expect(passed).toHaveLength(catalog.length);
    for (const p of passed) {
      expect([...p.perPerson.keys()]).toEqual([1, 2]);
      expect(p.perPerson.get(1)!.totalCents).toBeGreaterThan(0);
    }
  });

  it("vetoes a place by name, even from raw chatter like 'cancun is too pricey for me'", () => {
    for (const veto of ["cancun", "Cancún", "cancun is too pricey for me"]) {
      const { passed, rejected } = hardFilter(catalog, group([member({ personId: 7, name: "maya", vetoes: [veto] })]));
      expect(ids(passed)).not.toContain("cancun");
      expect(ids(passed)).toContain("tulum");
      expect(rejected).toEqual([{ destinationId: "cancun", reason: "maya vetoed Cancún", personId: 7 }]);
    }
  });

  it("vetoes by tag", () => {
    const { passed, rejected } = hardFilter(catalog, group([member({ personId: 1, name: "leo", vetoes: ["beaches"] })]));
    expect(passed.length).toBeGreaterThan(0);
    for (const p of passed) expect(p.dest.tags).not.toContain("beach");
    expect(reasonsFor(rejected, "miami")).toEqual(["leo vetoed beach places"]);
  });

  it("vetoes cold places, regions and international trips", () => {
    const cold = hardFilter(catalog, group([member({ personId: 1, name: "priya", vetoes: ["cold"] })]));
    expect(reasonsFor(cold.rejected, "reykjavik")).toEqual(["priya vetoed cold places"]);
    expect(ids(cold.passed)).toContain("miami");

    const europe = hardFilter(catalog, group([member({ personId: 1, name: "sam", vetoes: ["europe"] })]));
    expect(europe.passed.some((p) => p.dest.region === "europe")).toBe(false);

    const intl = hardFilter(catalog, group([member({ personId: 1, name: "sam", vetoes: ["international"] })]));
    expect(ids(intl.passed)).toContain("san-juan");
    expect(intl.passed.every((p) => p.dest.country === "United States" || p.dest.country === "Puerto Rico")).toBe(true);
  });

  it("rejects bad months with the reason", () => {
    const sept = hardFilter(catalog, group([member({ personId: 1, name: "maya" })], { startDate: "2026-09-10", endDate: "2026-09-14" }));
    expect(reasonsFor(sept.rejected, "myrtle-beach")).toEqual(["hurricane season in September"]);
    expect(ids(sept.passed)).toContain("asheville");

    const jan = hardFilter(catalog, group([member({ personId: 1, name: "maya" })], { startDate: "2027-01-08", endDate: "2027-01-11" }));
    expect(reasonsFor(jan.rejected, "chicago")).toEqual(["freezing in January"]);
    expect(ids(jan.passed)).toContain("miami");
  });

  it("checks every month a trip spans", () => {
    expect(tripMonths("2026-08-29", "2026-09-03")).toEqual([8, 9]);
    expect(tripMonths("2026-12-30", "2027-01-02")).toEqual([12, 1]);
    expect(tripMonths()).toEqual([]);
    const g = group([member({ personId: 1, name: "maya" })], { startDate: "2026-08-29", endDate: "2026-09-03" });
    expect(reasonsFor(hardFilter(catalog, g).rejected, "charleston")).toEqual(["hurricane season in September"]);
  });

  it("requires each member's dietary needs to be easy (vegetarian)", () => {
    const g = group([member({ personId: 3, name: "priya", dietary: ["Vegetarian"] })]);
    const { passed, rejected } = hardFilter(catalog, g);
    expect(rejected).toContainEqual({ destinationId: "gatlinburg", reason: "not enough vegetarian options for priya", personId: 3 });
    expect(ids(passed)).toContain("new-york");
    for (const p of passed) expect(p.dest.dietary.vegetarian).toBeGreaterThanOrEqual(0.5);
  });

  it("understands gluten-free spellings and ignores needs it can't check", () => {
    const gf = hardFilter(catalog, group([member({ personId: 1, name: "leo", dietary: ["gluten-free", "no cilantro"] })]));
    expect(reasonsFor(gf.rejected, "gatlinburg")).toEqual(["not enough gluten-free options for leo"]);
    expect(ids(gf.passed)).toContain("portland");
  });

  it("rejects places over someone's budget ceiling, saying by how much", () => {
    const honolulu = dest("honolulu");
    const estimate = estimateCost(honolulu, { homeAirport: "RDU" }, 4, "budget", 2);
    const ceiling = estimate.totalCents - 14_000;
    const g = group([member({ personId: 1, name: "maya", budgetCeilingCents: ceiling }), member({ personId: 2, name: "leo" })]);
    const { passed, rejected } = hardFilter(catalog, g);
    expect(reasonsFor(rejected, "honolulu")).toEqual(["over maya's ceiling by ~$140"]);
    expect(rejected.find((r) => r.destinationId === "honolulu")?.personId).toBe(1);
    for (const p of passed) expect(p.perPerson.get(1)!.totalCents).toBeLessThanOrEqual(ceiling);
  });

  it("'can't fly' leaves only places within driving range", () => {
    const g = group([member({ personId: 4, name: "sam", noFlying: true }), member({ personId: 5, name: "maya" })]);
    const { passed, rejected } = hardFilter(catalog, g);
    expect(passed.length).toBeGreaterThan(3);
    for (const p of passed) expect(p.perPerson.get(4)!.transportHours).toBeLessThanOrEqual(8);
    expect(ids(passed)).toEqual(expect.arrayContaining(["asheville", "charleston", "outer-banks", "washington-dc"]));
    expect(reasonsFor(rejected, "cancun")).toEqual(["sam can't fly and there's no reasonable drive"]);
    expect(reasonsFor(rejected, "orlando")).toEqual(["too far to drive for sam (~10h, max 8h)"]);
    for (const p of passed) expect(p.perPerson.get(4)!.transportMode).toBe("drive");
  });

  it("respects a tighter drive limit", () => {
    const g = group([member({ personId: 4, name: "sam", noFlying: true, maxDriveHours: 3 })]);
    const { passed } = hardFilter(catalog, g);
    expect(ids(passed).sort()).toEqual(["myrtle-beach", "wilmington"]);
  });

  it("rejects flights longer than someone's limit", () => {
    const g = group([member({ personId: 2, name: "leo", maxFlightHours: 6 })]);
    const { passed, rejected } = hardFilter(catalog, g);
    expect(reasonsFor(rejected, "london")).toEqual(["flight's too long for leo (~9h, max 6h)"]);
    expect(ids(passed)).toContain("miami");
    // Drivers aren't held to a flight limit.
    expect(ids(passed)).toContain("asheville");
  });

  it("no passport → domestic and Puerto Rico only", () => {
    const g = group([member({ personId: 1, name: "maya", noPassport: true })]);
    const { passed, rejected } = hardFilter(catalog, g);
    expect(passed.every((p) => !p.dest.passportRequired)).toBe(true);
    expect(ids(passed)).toContain("san-juan");
    expect(reasonsFor(rejected, "tulum")).toEqual(["maya doesn't have a passport"]);
  });

  it("low mobility needs enough easy activities", () => {
    const hilly: Destination = {
      ...dest("asheville"),
      id: "hilly-town",
      name: "Hilly Town",
      activities: dest("asheville").activities.map((a, i) => ({ ...a, mobility: i < 3 ? "easy" : "strenuous" })),
    };
    const g = group([member({ personId: 9, name: "nana", mobility: "low" })]);
    const { passed, rejected } = hardFilter([hilly, dest("charleston")], g);
    expect(rejected).toEqual([{ destinationId: "hilly-town", reason: "not enough easy-going activities for nana", personId: 9 }]);
    expect(ids(passed)).toEqual(["charleston"]);
  });

  it("collects every reason a place fails, in a stable order", () => {
    const g = group(
      [
        member({ personId: 1, name: "maya", vetoes: ["nassau"], budgetCeilingCents: 50_000 }),
        member({ personId: 2, name: "leo", noPassport: true }),
      ],
      { startDate: "2026-09-20", endDate: "2026-09-24" },
    );
    const reasons = reasonsFor(hardFilter(catalog, g).rejected, "nassau");
    expect(reasons[0]).toBe("maya vetoed Nassau");
    expect(reasons[1]).toBe("hurricane season in September");
    expect(reasons).toContain("leo doesn't have a passport");
    expect(reasons.some((r) => r.startsWith("over maya's ceiling by ~$"))).toBe(true);
    expect(hardFilter(catalog, g)).toEqual(hardFilter(catalog, g));
  });
});

describe("vetoMatch", () => {
  it("does not over-match", () => {
    expect(vetoMatch(dest("tulum"), "cancun")).toBeUndefined();
    expect(vetoMatch(dest("denver"), "cold", [7])).toBeUndefined();
    expect(vetoMatch(dest("denver"), "cold", [1])).toBe("cold places");
    expect(vetoMatch(dest("new-york"), "city")).toBe("city places");
    expect(vetoMatch(dest("asheville"), "mexico")).toBeUndefined();
    expect(vetoMatch(dest("cancun"), "mexico")).toBe("Mexico");
  });
});
