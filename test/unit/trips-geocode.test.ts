// Off-catalog places: Open-Meteo geocoding (fake fetch, never the network), its caches and stubs,
// and the place shaped as a catalog destination.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKeyFor, clearGeocodeCache, geocodePlace, GeocodeUnavailable, pickResult, placeLabel, splitQuery, stubGeocode, type GeocodeCache } from "../../src/trips/geocode.ts";
import { flightBandForMiles, nearestAirport, placeAsDestination, placeOf, tripDestination } from "../../src/trips/place.ts";
import { driveHoursFor, travelPlan } from "../../src/trips/estimate.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/open-meteo/${name}`, import.meta.url), "utf8");
const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(...responses: (Response | Error)[]) {
  const urls: URL[] = [];
  const impl = vi.fn(async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    const r = responses[Math.min(urls.length - 1, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    return r.clone();
  });
  return { fetch: impl as unknown as typeof fetch, impl, urls };
}

const PORTLANDS = {
  results: [
    { name: "Portland", latitude: 45.52, longitude: -122.68, timezone: "America/Los_Angeles", country: "United States", country_code: "US", admin1: "Oregon", population: 650000 },
    { name: "Portland", latitude: 43.66, longitude: -70.26, timezone: "America/New_York", country: "United States", country_code: "US", admin1: "Maine", population: 68000 },
  ],
};

afterEach(() => clearGeocodeCache());

describe("geocodePlace", () => {
  it("resolves a name to coordinates from the API", async () => {
    const f = fakeFetch(json(fixture("geocode-lisbon.json")));
    const place = await geocodePlace("Lisbon", { fetch: f.fetch });
    expect(place).toEqual({ name: "Lisbon", admin1: "Lisbon District", country: "Portugal", countryCode: "PT", lat: 38.72509, lon: -9.1498, timezone: "Europe/Lisbon", population: 517802 });
    expect(f.urls[0]!.origin + f.urls[0]!.pathname).toBe("https://geocoding-api.open-meteo.com/v1/search");
    expect(f.urls[0]!.searchParams.get("name")).toBe("Lisbon");
  });

  it("a state after a comma picks the matching result and isn't sent as part of the name", async () => {
    const f = fakeFetch(json(PORTLANDS));
    const place = await geocodePlace("portland, me", { fetch: f.fetch });
    expect(place).toMatchObject({ name: "Portland", admin1: "Maine" });
    expect(f.urls[0]!.searchParams.get("name")).toBe("portland");
    expect(f.urls[0]!.searchParams.get("count")).toBe("10");
  });

  it("a qualifier nothing matches is a miss, not a wrong place", async () => {
    const f = fakeFetch(json(PORTLANDS));
    expect(await geocodePlace("portland, tx", { fetch: f.fetch })).toBeNull();
  });

  it("no results is null", async () => {
    const f = fakeFetch(json(fixture("geocode-empty.json")));
    expect(await geocodePlace("zzqxwv", { fetch: f.fetch })).toBeNull();
  });

  it("blank input never calls the API", async () => {
    const f = fakeFetch(json(PORTLANDS));
    expect(await geocodePlace("   ", { fetch: f.fetch })).toBeNull();
    expect(f.impl).not.toHaveBeenCalled();
  });

  it("answers and misses are cached in memory (one request per name)", async () => {
    const f = fakeFetch(json(fixture("geocode-lisbon.json")));
    await geocodePlace("Lisbon", { fetch: f.fetch });
    await geocodePlace("  lisbon ", { fetch: f.fetch });
    expect(f.impl).toHaveBeenCalledTimes(1);
    const g = fakeFetch(json(fixture("geocode-empty.json")));
    await geocodePlace("nowhere", { fetch: g.fetch });
    await geocodePlace("nowhere", { fetch: g.fetch });
    expect(g.impl).toHaveBeenCalledTimes(1);
  });

  it("reads and writes a persistent cache", async () => {
    const store = new Map<string, { body: unknown; fetchedAt: Date }>();
    const cache: GeocodeCache = { get: async (k) => store.get(k), set: async (k, body, at) => void store.set(k, { body, fetchedAt: at }) };
    const at = new Date("2026-10-10T12:00:00Z");
    const f = fakeFetch(json(fixture("geocode-lisbon.json")));
    await geocodePlace("Lisbon", { fetch: f.fetch, cache, now: () => at });
    expect(store.get(cacheKeyFor("Lisbon"))?.body).toMatchObject({ place: { name: "Lisbon" } });
    clearGeocodeCache(); // a restart: memory is gone, the table isn't
    const g = fakeFetch(new Error("offline"));
    expect(await geocodePlace("lisbon", { fetch: g.fetch, cache, now: () => at })).toMatchObject({ name: "Lisbon" });
    expect(g.impl).not.toHaveBeenCalled();
  });

  it("a stale cached miss is asked again", async () => {
    const store = new Map<string, { body: unknown; fetchedAt: Date }>();
    store.set(cacheKeyFor("lisbon"), { body: { place: null }, fetchedAt: new Date("2026-10-01T00:00:00Z") });
    const cache: GeocodeCache = { get: async (k) => store.get(k), set: async (k, body, at) => void store.set(k, { body, fetchedAt: at }) };
    const f = fakeFetch(json(fixture("geocode-lisbon.json")));
    const place = await geocodePlace("lisbon", { fetch: f.fetch, cache, now: () => new Date("2026-10-10T00:00:00Z") });
    expect(place?.name).toBe("Lisbon");
  });

  it("an unreachable API throws GeocodeUnavailable (not a miss)", async () => {
    const f = fakeFetch(new TypeError("fetch failed"));
    await expect(geocodePlace("Lisbon", { fetch: f.fetch })).rejects.toBeInstanceOf(GeocodeUnavailable);
  });

  it("a hung API times out", async () => {
    const hang = vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))));
    await expect(geocodePlace("Lisbon", { fetch: hang as unknown as typeof fetch, timeoutMs: 30 })).rejects.toBeInstanceOf(GeocodeUnavailable);
  });

  it("stubs answer without the network (simulator)", async () => {
    stubGeocode("boone, nc", { name: "Boone", admin1: "North Carolina", country: "United States", countryCode: "US", lat: 36.2168, lon: -81.6746 });
    stubGeocode("atlantis", null);
    const f = fakeFetch(new Error("network used"));
    expect(await geocodePlace("Boone, NC", { fetch: f.fetch })).toMatchObject({ name: "Boone" });
    expect(await geocodePlace("atlantis", { fetch: f.fetch })).toBeNull();
    expect(f.impl).not.toHaveBeenCalled();
  });
});

describe("query helpers", () => {
  it("splits a state or country off the name", () => {
    expect(splitQuery("lake lure, nc")).toEqual({ name: "lake lure", qualifier: "north carolina" });
    expect(splitQuery("Porto, Portugal")).toEqual({ name: "Porto", qualifier: "portugal" });
    expect(splitQuery("boone")).toEqual({ name: "boone" });
  });

  it("rejects a malformed body", () => {
    expect(() => pickResult({ results: [{ name: 1 }] })).toThrow(GeocodeUnavailable);
  });

  it("labels US places with their state and others with their country", () => {
    expect(placeLabel({ name: "Boone", admin1: "North Carolina", countryCode: "US" })).toBe("Boone, North Carolina");
    expect(placeLabel({ name: "Porto", country: "Portugal" })).toBe("Porto, Portugal");
  });
});

describe("a geocoded place as a destination", () => {
  const boone = { name: "Boone", admin1: "North Carolina", country: "United States", countryCode: "US", lat: 36.2168, lon: -81.6746, timezone: "America/New_York" };

  it("gets the nearest home airport, a region and no passport", () => {
    const d = placeAsDestination(boone);
    expect(d.id).toBe("place:boone");
    expect(d.iata).toBe("CLT");
    expect(d.region).toBe("southeast_us");
    expect(d.passportRequired).toBe(false);
    expect(d.costs.lodgingPerNightCents.budget).toBeGreaterThan(0);
  });

  it("drive hours come from coordinates", () => {
    const d = placeAsDestination(boone);
    const fromRaleigh = driveHoursFor(d, { homeAirport: "RDU" })!;
    expect(fromRaleigh).toBeGreaterThanOrEqual(2.5);
    expect(fromRaleigh).toBeLessThanOrEqual(4);
    expect(travelPlan(d, { homeAirport: "RDU", homeRegion: "southeast_us" }, 3).mode).toBe("drive");
    expect(travelPlan(d, { homeAirport: "BOS", homeRegion: "northeast_us" }, 3).mode).toBe("flight");
  });

  it("abroad: flights only, passport needed, no drive", () => {
    const d = placeAsDestination({ name: "Porto", country: "Portugal", countryCode: "PT", lat: 41.15, lon: -8.61 });
    expect(d.passportRequired).toBe(true);
    expect(d.iata).toBe("");
    expect(driveHoursFor(d, { homeAirport: "JFK" })).toBeUndefined();
    expect(d.flightFromRegion.northeast_us!.roundTripCents[0]).toBeGreaterThan(30_000);
  });

  it("fare bands grow with distance", () => {
    const near = flightBandForMiles(400, true);
    const far = flightBandForMiles(2_500, true);
    expect(far.roundTripCents[0]).toBeGreaterThan(near.roundTripCents[0]);
    expect(far.hours).toBeGreaterThan(near.hours);
    expect(flightBandForMiles(400, false).hours).toBeGreaterThan(near.hours);
  });

  it("nearestAirport respects its range", () => {
    expect(nearestAirport(36.2168, -81.6746)?.airport.iata).toBe("CLT");
    expect(nearestAirport(41.15, -8.61)).toBeUndefined();
  });

  it("round-trips through placeOf, and the trip row resolves either kind", () => {
    const d = placeAsDestination(boone);
    expect(placeOf(d)).toMatchObject({ name: "Boone", admin1: "North Carolina", country: "United States", lat: 36.2168 });
    expect(tripDestination({ destination_id: null, destination_place: boone })?.id).toBe("place:boone");
    expect(tripDestination({ destination_id: "asheville", destination_place: null })?.name).toBe("Asheville");
    expect(tripDestination({ destination_id: null, destination_place: null })).toBeUndefined();
  });
});
