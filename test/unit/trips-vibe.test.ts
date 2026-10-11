// Persona-QA regressions: the group's vibe is a requirement, travel limits are hard, drives are
// drives, headers match the count, and itineraries don't repeat or ignore the season.
import { describe, expect, it } from "vitest";
import type { PersonProfile, Resolved } from "../../src/profile/aggregate.ts";
import { groupView } from "../../src/profile/groupView.ts";
import { destinations, findDestination, normalizeTag, type Destination } from "../../src/trips/catalog.ts";
import { applyGroupAsk, buildConstraints } from "../../src/trips/constraints.ts";
import { driveHoursFor, estimateCost, travelPlan } from "../../src/trips/estimate.ts";
import { hardFilter } from "../../src/trips/filter.ts";
import { dayLabel, draftItinerary } from "../../src/trips/itinerary.ts";
import { applyVibe, bestReason, inferVibe, pickThree, scoreDestinations, vibeTags } from "../../src/trips/score.ts";
import { proposalHeader, tieMessage, PICK_FOR_US } from "../../src/agent/features/proposals.ts";

const catalog = destinations();
let factId = 1;
const r = <T>(value: T, quote = "", confidence = 0.9): Resolved<T> => ({ value, factId: factId++, quote, observedAt: new Date("2026-10-01T12:00:00Z"), confidence, explicit: true });

function profile(personId: number, p: Partial<PersonProfile>): PersonProfile {
  return { personId, blackouts: [], dietary: [], wants: [], vetoes: [], likes: [], dislikes: [], travelLimits: [], tooExpensive: [], ...p };
}

function dest(id: string): Destination {
  const d = findDestination(id);
  if (!d) throw new Error(`no destination ${id}`);
  return d;
}

const window = (start: string, end: string) => ({ earliest: r(start), latest: r(end) });

describe("travel limits (omar: no flying, max 5h driving, from richmond)", () => {
  const view = groupView(
    [
      { personId: 1, label: "Omar", profile: profile(1, { homeCity: r("Richmond"), ...window("2026-11-13", "2026-11-16"), travelLimits: [r({ kind: "no_flying", hours: null }, "omar can't fly"), r({ kind: "max_drive_hours", hours: 5 }, "max 5 hours driving")] }) },
      { personId: 2, label: "Maya", profile: profile(2, { homeCity: r("Baltimore"), ...window("2026-11-13", "2026-11-16") }) },
      { personId: 3, label: "Leo", profile: profile(3, { homeCity: r("Chapel Hill"), ...window("2026-11-13", "2026-11-16") }) },
    ],
    "2026-10-10",
  );
  const built = buildConstraints(view, []);
  const omar = built.group.members.find((m) => m.personId === 1)!;

  it("reads both limits into omar's constraints", () => {
    expect(omar).toMatchObject({ noFlying: true, maxDriveHours: 5, homeAirport: "RIC" });
  });

  it("only passes places omar can drive to in 5h, and he always drives", () => {
    const { passed, rejected } = hardFilter(catalog, built.group);
    expect(passed.length).toBeGreaterThan(0);
    for (const p of passed) {
      const c = p.perPerson.get(1)!;
      expect(c.transportMode).toBe("drive");
      expect(c.transportHours!).toBeLessThanOrEqual(5);
    }
    expect(passed.map((p) => p.dest.id)).toEqual(expect.arrayContaining(["washington-dc", "outer-banks"]));
    expect(passed.map((p) => p.dest.id)).not.toContain("miami");
    expect(passed.map((p) => p.dest.id)).not.toContain("asheville"); // ~6h from richmond
    expect(rejected.find((x) => x.destinationId === "cancun")?.reason).toMatch(/omar can't fly/i);
  });

  it("a non-flyer's estimate is never a flight", () => {
    for (const d of catalog) expect(estimateCost(d, omar, 3, "budget", 3).transportMode).toBe("drive");
  });
});

describe("drive vs fly from home", () => {
  it("charlotte → gatlinburg and raleigh/chapel hill → asheville are drives", () => {
    expect(travelPlan(dest("gatlinburg"), { homeAirport: "CLT", homeRegion: "southeast_us" }, 3)).toMatchObject({ mode: "drive" });
    expect(driveHoursFor(dest("gatlinburg"), { homeAirport: "CLT" })).toBeLessThanOrEqual(4);
    for (const home of ["RDU", "Chapel Hill", "Raleigh"]) {
      expect(travelPlan(dest("asheville"), { homeAirport: home }, 3).mode).toBe("drive");
    }
  });

  it("long hauls still fly, and islands never drive", () => {
    expect(travelPlan(dest("denver"), { homeAirport: "RDU" }, 3).mode).toBe("flight");
    expect(driveHoursFor(dest("honolulu"), { homeAirport: "RDU" })).toBeUndefined();
    expect(driveHoursFor(dest("cancun"), { homeAirport: "RDU" })).toBeUndefined();
  });

  it("a group 'anything drivable within 5h' ask makes everyone drive", () => {
    const view = groupView([{ personId: 1, label: "Maya", profile: profile(1, { homeCity: r("Raleigh") }) }], "2026-10-10");
    const g = applyGroupAsk(buildConstraints(view, []).group, { maxDriveHours: 5, maxPerPersonUsd: 800 });
    const { passed } = hardFilter(catalog, g);
    expect(passed.length).toBeGreaterThan(2);
    for (const p of passed) {
      expect(p.perPerson.get(1)!.transportMode).toBe("drive");
      expect(p.perPerson.get(1)!.totalCents).toBeLessThanOrEqual(80_000);
    }
  });
});

describe("vibe", () => {
  const ncGroup = (likes: Record<number, string[]>, dislikes: Record<number, string[]> = {}) =>
    groupView(
      [1, 2, 3].map((id) => ({
        personId: id,
        label: ["", "Maya", "Leo", "Priya"][id]!,
        profile: profile(id, {
          homeCity: r(["", "Raleigh", "Charlotte", "Chapel Hill"][id]!),
          ...window("2026-03-07", "2026-03-11"),
          likes: (likes[id] ?? []).map((t) => r(t)),
          dislikes: (dislikes[id] ?? []).map((t) => r(t)),
        }),
      })),
      "2026-10-10",
    );

  function propose(view: ReturnType<typeof groupView>, vibe?: string[]) {
    const built = buildConstraints(view, []);
    const { passed } = hardFilter(catalog, built.group);
    const scored = scoreDestinations(passed, built.group, built.prefs, 3);
    const tags = vibe ? vibeTags(vibe) : inferVibe(built.prefs);
    const v = applyVibe(scored, tags, [3]);
    return { picks: pickThree(v.kept, { cover: v.covered, months: [3] }), v, tags };
  }

  it("a beach trip is only beaches (spring break from NC)", () => {
    const { picks, tags } = propose(ncGroup({ 1: ["beach"], 2: ["beach"] }));
    expect(tags).toEqual(["beach"]);
    expect(picks).toHaveLength(3);
    for (const p of picks) expect(p.dest.tags).toContain("beach");
  });

  it("an explicit vibe wins even with no likes, and a split vibe gets one of each", () => {
    const beach = propose(ncGroup({}), ["beaches"]);
    for (const p of beach.picks) expect(p.dest.tags).toContain("beach");
    const split = propose(ncGroup({}), ["ski", "beach"]);
    expect(split.picks.some((p) => p.dest.tags.includes("snow"))).toBe(true);
    expect(split.picks.some((p) => p.dest.tags.includes("beach"))).toBe(true);
  });

  it("someone disliking the setting means it's not required", () => {
    expect(inferVibe(buildConstraints(ncGroup({ 1: ["beach"] }, { 3: ["beach"] }), []).prefs)).toEqual([]);
  });

  it("christmas markets maps to the holiday tag", () => {
    expect(normalizeTag("christmas markets")).toBe("holiday");
    expect(vibeTags("mountains or christmas markets")).toEqual(["mountains", "holiday"]);
  });

  it("falls back honestly when fewer than two places have the vibe", () => {
    const view = ncGroup({});
    const built = buildConstraints(view, []);
    const { passed } = hardFilter(catalog, built.group);
    const scored = scoreDestinations(passed, built.group, built.prefs, 3).filter((s) => s.dest.id !== "charleston" && (s.dest.id === "outer-banks" || !s.dest.tags.includes("beach")));
    const v = applyVibe(scored, ["beach"], [3]);
    expect(v.strict).toBe(false);
    expect(v.short).toEqual([{ tag: "beach", count: 1 }]);
  });

  it("a short trip from NC prefers close places over medellín/montreal", () => {
    const { picks } = propose(ncGroup({}));
    for (const p of picks) expect(["medellin", "montreal", "lisbon", "london", "reykjavik"]).not.toContain(p.dest.id);
  });

  it("prints one meaningful reason, never the same person twice", () => {
    const { picks } = propose(ncGroup({ 1: ["city", "mountains"] }), ["city", "mountains"]);
    for (const p of picks) {
      expect(p.reasons.join(" | ")).not.toMatch(/for maya, .* for maya/);
      const why = bestReason(p, { groupSize: 3, vibe: ["city"] });
      if (why) expect(why).not.toMatch(/^great in/);
    }
  });
});

describe("copy", () => {
  it("the header count matches the options", () => {
    expect(proposalHeader(3, "nov 15–16")).toMatch(/^ok, three options for nov 15–16 👇/);
    expect(proposalHeader(2, "nov 15–16")).toMatch(/^two spots fit everyone for nov 15–16 👇/);
    expect(proposalHeader(1, "nov 15–16")).toMatch(/^only one spot fits everyone/);
    expect(proposalHeader(2, "nov 15–16", { vibe: "beach", leadIn: "fair, beaches only this time" })).toMatch(/^fair, beaches only this time 👇\ntwo beach spots fit everyone/);
  });

  it("calls a tie a tie and offers the cheaper one", () => {
    expect(tieMessage(["atlanta", "asheville"], [2, 2], 0, true)).toBe(`it's a tie: atlanta 2, asheville 2. anyone want to switch? or i'll go with the cheaper one (atlanta), say "pick for us"`);
    for (const t of ["pick for us", "atlas you pick", "ok you decide", "just pick one lol"]) expect(PICK_FOR_US.test(t), t).toBe(true);
    expect(PICK_FOR_US.test("i'll pick up snacks")).toBe(false);
  });
});

describe("itinerary", () => {
  it("no tubing or rafting in december, no repeats on a long trip, dated labels", () => {
    for (const id of ["asheville", "gatlinburg"]) {
      const days = draftItinerary(dest(id), "2026-12-05", "2026-12-12", { relaxing: 3, outdoors: 2, adventure: 2 });
      const names = days.flatMap((d) => d.items.map((i) => i.name.toLowerCase()));
      expect(names.join(" | ")).not.toMatch(/tubing|rafting/);
      expect(new Set(names).size).toBe(names.length);
      for (const d of days) expect(d.items.length).toBeLessThanOrEqual(2);
    }
    expect(draftItinerary(dest("asheville"), "2026-07-04", "2026-07-08", { relaxing: 3, adventure: 3 }).flatMap((d) => d.items.map((i) => i.name))).toContain("Tubing the French Broad River");
    expect(dayLabel("2026-03-07")).toBe("sat 3/7");
  });
});
