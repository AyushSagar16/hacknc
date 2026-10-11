// Travel plans: drive vs fly per person, carpools by metro, gas shares and fares, overrides,
// and the rundown text (every $ in it registered for the money guard).
import { describe, expect, it } from "vitest";
import { destinationById } from "../../src/trips/catalog.ts";
import { placeAsDestination } from "../../src/trips/place.ts";
import { carGasCents, flightEstimateCents, planTravel, type TravelMember } from "../../src/trips/travel.ts";
import { legLine, rundownText, travelFigures } from "../../src/agent/features/travel.ts";
import { Figures } from "../../src/agent/figures.ts";

const boone = placeAsDestination({ name: "Boone", admin1: "North Carolina", country: "United States", countryCode: "US", lat: 36.2168, lon: -81.6746 });
const dates = { start: "2026-11-12", end: "2026-11-15" };
const m = (personId: number, name: string, origin?: string, extra: Partial<TravelMember> = {}): TravelMember => ({ personId, name, ...(origin ? { origin } : {}), ...extra });
const byId = (legs: ReturnType<typeof planTravel>) => new Map(legs.map((l) => [l.personId, l]));

describe("planTravel", () => {
  it("drivers from the same metro share a car and split the gas", () => {
    const legs = byId(planTravel(boone, [m(1, "maya", "Raleigh"), m(2, "leo", "Durham"), m(3, "priya", "Charlotte")], { dates }));
    const maya = legs.get(1)!;
    const leo = legs.get(2)!;
    expect(maya.mode).toBe("drive");
    expect(maya.carpoolGroup).toBe("rdu-1");
    expect(leo.carpoolGroup).toBe("rdu-1");
    expect(maya.carpoolWith).toEqual([2]);
    expect(maya.costCents).toBe(Math.round(carGasCents(maya.hours!) / 2 / 100) * 100);
    // Alone in the car: pays the whole tank.
    const priya = legs.get(3)!;
    expect(priya.carpoolGroup).toBeNull();
    expect(priya.costCents).toBe(Math.round(carGasCents(priya.hours!) / 100) * 100);
  });

  it("five drivers from one metro need two cars", () => {
    const legs = planTravel(boone, [1, 2, 3, 4, 5].map((i) => m(i, `p${i}`, "Raleigh")), { dates });
    expect(new Set(legs.map((l) => l.carpoolGroup))).toEqual(new Set(["rdu-1", null]));
    expect(legs.filter((l) => l.carpoolGroup === "rdu-1")).toHaveLength(4);
  });

  it("far away flies, with an estimated fare and a Google Flights link to the nearest airport", () => {
    const sam = planTravel(boone, [m(4, "sam", "Boston")], { dates })[0]!;
    expect(sam.mode).toBe("fly");
    expect(sam.originIata).toBe("BOS");
    expect(sam.costSource).toBe("estimate");
    expect(sam.costCents! % 500).toBe(0);
    expect(sam.link).toContain("google.com/travel/flights");
    expect(decodeURIComponent(sam.link!)).toContain("Flights to CLT from BOS on 2026-11-12 through 2026-11-15");
  });

  it("uses a live fare when there is one", () => {
    const sam = planTravel(boone, [m(4, "sam", "Boston")], { dates, fares: new Map([[4, { cents: 21_337 }]]) })[0]!;
    expect(sam.costCents).toBe(21_337);
    expect(sam.costSource).toBe("live");
  });

  it("\"i'll drive\" overrides a flight when there's a road", () => {
    const sam = planTravel(boone, [m(4, "sam", "Boston", { override: "drive" })], { dates })[0]!;
    expect(sam.mode).toBe("drive");
    expect(sam.overridden).toBe(true);
    expect(sam.hours).toBeGreaterThan(8);
  });

  it("\"i'll fly\" overrides a short drive", () => {
    const maya = planTravel(boone, [m(1, "maya", "Raleigh", { override: "fly" })], { dates })[0]!;
    expect(maya.mode).toBe("fly");
    expect(maya.costCents).toBeGreaterThan(0);
  });

  it("no road to an island: the driver flies and it's flagged", () => {
    const honolulu = destinationById("honolulu")!;
    const leg = planTravel(honolulu, [m(1, "maya", "Raleigh", { override: "drive" })], { dates })[0]!;
    expect(leg.mode).toBe("fly");
    expect(leg.problem).toBe("no_road");
  });

  it("someone who can't fly drives", () => {
    const leg = planTravel(boone, [m(4, "sam", "Boston", { noFlying: true })], { dates })[0]!;
    expect(leg.mode).toBe("drive");
  });

  it("no home city: no numbers, flagged", () => {
    const leg = planTravel(boone, [m(5, "jo")], { dates })[0]!;
    expect(leg.problem).toBe("no_home");
    expect(leg.costCents).toBeNull();
  });

  it("flight estimate falls back to distance when the catalog has no band", () => {
    const est = flightEstimateCents(boone, undefined);
    expect(est.cents).toBeGreaterThan(0);
  });
});

describe("rundown", () => {
  const legs = planTravel(boone, [m(1, "maya", "Raleigh"), m(2, "leo", "Durham"), m(3, "priya", "Charlotte"), m(4, "sam", "Boston"), m(5, "jo")], { dates });

  it("one line per car or person, flight links, and the personal-cost note", () => {
    const text = rundownText("Boone", legs);
    const lines = text.split("\n");
    expect(lines[0]).toBe("how everyone gets to boone 🚗");
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(4); // maya + leo share a line
    expect(text).toMatch(/- maya and leo: carpool from raleigh\/durham, ~3h, ~\$\d+ each for gas/);
    expect(text).toMatch(/- priya: drive from charlotte, ~2h, ~\$\d+ for gas/);
    expect(text).toMatch(/- sam: fly from boston, ~\$\d+ round trip \(est\.\)/);
    expect(text).toContain("- jo: need to know where you're leaving from");
    expect(text).toContain("✈️ sam from bos: https://www.google.com/travel/flights");
    expect(text).toContain("travel's on each of you");
  });

  it("every dollar figure in the rundown passes the money guard", () => {
    const figures = new Figures();
    figures.addAll(travelFigures(legs));
    expect(figures.check(rundownText("Boone", legs), { isGroup: true }).ok).toBe(true);
  });

  it("a single person's line after an override", () => {

    expect(legLine(legs[2]!, legs)).toMatch(/^priya: drive from charlotte/);
  });
});
