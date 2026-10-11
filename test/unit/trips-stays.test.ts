import { describe, expect, it } from "vitest";
import hotelsChs from "../fixtures/serpapi/google_hotels_charleston.json" with { type: "json" };
import rentalsChs from "../fixtures/serpapi/google_vacation_rentals_charleston.json" with { type: "json" };
import hotelsSju from "../fixtures/serpapi/google_hotels_san_juan.json" with { type: "json" };
import { destinationById } from "../../src/trips/catalog.ts";
import { estimatedStays, findStays, parseStays, pickStays, setStayFixture, sleepsOf, staySearchParams } from "../../src/trips/stays.ts";
import type { PriceDeps } from "../../src/trips/pricing.ts";

const opts = { nights: 4, groupSize: 3, fallbackLink: "https://www.google.com/travel/hotels?q=x" };

describe("stay search params", () => {
  it("asks google_hotels for hotels, and for whole-home rentals sized for everyone", () => {
    expect(staySearchParams("Charleston", "2026-11-12", "2026-11-16", 3, false)).toMatchObject({ engine: "google_hotels", q: "Charleston hotels", adults: "2" });
    const rentals = staySearchParams("Charleston", "2026-11-12", "2026-11-16", 3, true);
    expect(rentals).toMatchObject({ engine: "google_hotels", vacation_rentals: "true", adults: "3", check_in_date: "2026-11-12", check_out_date: "2026-11-16" });
  });
});

describe("parsing stays", () => {
  it("prices hotels for enough rooms and rentals for the whole place", () => {
    const all = [...parseStays(hotelsChs, opts), ...parseStays(rentalsChs, opts)];
    const hampton = all.find((s) => s.name === "Hampton Inn Historic District")!;
    expect(hampton).toMatchObject({ kind: "hotel", rooms: 2, totalCents: 119_200, perPersonCents: 39_733, perPersonNightCents: 9_933, rating: 4.2 });
    const townhouse = all.find((s) => s.name === "Harleston Village Townhouse")!;
    expect(townhouse).toMatchObject({ kind: "rental", rooms: 1, sleeps: 6, totalCents: 124_000, link: "https://example.com/charleston/rental/0" });
  });

  it("drops rentals too small for the group and properties with no price", () => {
    const all = [...parseStays(hotelsChs, opts), ...parseStays(rentalsChs, opts)];
    expect(all.map((s) => s.name)).not.toContain("Tiny Studio on Spring St");
    expect(all.map((s) => s.name)).not.toContain("No Price Inn");
    expect(parseStays(rentalsChs, { ...opts, groupSize: 2 }).map((s) => s.name)).toContain("Tiny Studio on Spring St");
  });

  it("reads how many a rental sleeps", () => {
    expect(sleepsOf({ essential_info: ["Entire home", "Sleeps 8"] })).toBe(8);
    expect(sleepsOf({ essential_info: ["Entire home", "6 guests"] })).toBe(6);
    expect(sleepsOf({ essential_info: ["3 bedrooms"] })).toBe(6);
    expect(sleepsOf({})).toBeNull();
  });

  it("reads the existing hotel fixture too", () => {
    expect(parseStays(hotelsSju, { nights: 4, groupSize: 4, fallbackLink: "x" }).length).toBeGreaterThan(3);
    expect(parseStays({ error: "nope" }, opts)).toEqual([]);
  });
});

describe("picking three", () => {
  const all = [...parseStays(hotelsChs, opts), ...parseStays(rentalsChs, opts)];

  it("keeps to the budget cap: the cheapest, the best rated, a rental", () => {
    const picks = pickStays(all, 45_000);
    expect(picks).toHaveLength(3);
    expect(picks.every((p) => p.perPersonCents <= 45_000 && !p.overBudget)).toBe(true);
    expect(picks[0]!.name).toBe("Cozy Wagener Terrace Bungalow");
    expect(picks.map((p) => p.name)).toContain("Harleston Village Townhouse");
    expect(picks.map((p) => p.name)).not.toContain("The Dewberry");
  });

  it("nothing fits: the three cheapest, flagged", () => {
    const picks = pickStays(all, 1_000);
    expect(picks).toHaveLength(3);
    expect(picks.every((p) => p.overBudget)).toBe(true);
    expect(picks[0]!.name).toBe("Cozy Wagener Terrace Bungalow");
  });
});

describe("offline", () => {
  const charleston = destinationById("charleston")!;

  it("labeled estimates from the catalog when nothing live answers", () => {
    const est = estimatedStays(charleston, { start: "2026-11-12", end: "2026-11-16" }, 3);
    expect(est).toHaveLength(3);
    expect(est.every((e) => e.source === "estimate" && e.name.endsWith("(est.)") && e.link.startsWith("https://www.google.com/travel/hotels"))).toBe(true);
    expect(est.every((e) => e.totalCents === e.perPersonNightCents * 3 * 4)).toBe(true);
  });

  it("findStays falls back to estimates with no key and no cache, and uses fixtures when given", async () => {
    const deps: PriceDeps = { fetch: (() => Promise.reject(new Error("no network in tests"))) as typeof fetch, cache: { get: async () => undefined, set: async () => {} }, now: () => new Date("2026-10-10T12:00:00Z") };
    setStayFixture(undefined);
    const offline = await findStays(charleston, { start: "2026-11-12", end: "2026-11-16" }, 3, null, deps);
    expect(offline.live).toBe(false);
    expect(offline.options).toHaveLength(3);
    setStayFixture({ hotels: hotelsChs, rentals: rentalsChs });
    const live = await findStays(charleston, { start: "2026-11-12", end: "2026-11-16" }, 3, 45_000, deps);
    setStayFixture(undefined);
    expect(live.live).toBe(true);
    expect(live.options.map((o) => o.name)).toContain("Harleston Village Townhouse");
  });
});
