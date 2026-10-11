// Live prices for a geocoded (off-catalog) place, from SerpApi fixtures: hotels by name, flights
// into the nearest airport, and estimates when there's no key or no airport. No network.
import { describe, expect, it } from "vitest";
import flightsRdu from "../fixtures/serpapi/google_flights_rdu_sju.json" with { type: "json" };
import hotels from "../fixtures/serpapi/google_hotels_san_juan.json" with { type: "json" };
import { placeAsDestination } from "../../src/trips/place.ts";
import { cheapestFlightUsd, liveFlightFares, priceOption, type PriceCache, type PriceDeps } from "../../src/trips/pricing.ts";
import type { MemberConstraints } from "../../src/trips/filter.ts";

const NOW = new Date("2026-10-10T15:00:00Z");
const DATES = { start: "2026-11-12", end: "2026-11-15" };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function deps(apiKey?: string) {
  const urls: URL[] = [];
  const store = new Map<string, { body: unknown; fetchedAt: Date }>();
  const cache: PriceCache = { get: async (k) => store.get(k), set: async (k, body, at) => void store.set(k, { body, fetchedAt: at }) };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return json(url.searchParams.get("engine") === "google_hotels" ? hotels : flightsRdu);
  }) as unknown as typeof fetch;
  const d: PriceDeps = { apiKey, fetch: fetchImpl, cache, now: () => NOW };
  return { d, urls };
}

const boone = placeAsDestination({ name: "Boone", admin1: "North Carolina", country: "United States", countryCode: "US", lat: 36.2168, lon: -81.6746 });
const porto = placeAsDestination({ name: "Porto", country: "Portugal", countryCode: "PT", lat: 41.15, lon: -8.61 });
const members: MemberConstraints[] = [
  { personId: 1, name: "sam", homeAirport: "BOS", dietary: [], vetoes: [] },
  { personId: 2, name: "maya", homeAirport: "RDU", dietary: [], vetoes: [] },
];

describe("pricing an off-catalog place", () => {
  it("hotels are searched by the place's name and flights into its nearest airport", async () => {
    const { d, urls } = deps("k");
    const prices = await priceOption(boone, members, DATES, "budget", d);
    const hotel = urls.find((u) => u.searchParams.get("engine") === "google_hotels")!;
    expect(hotel.searchParams.get("q")).toBe("Boone hotels");
    const flight = urls.find((u) => u.searchParams.get("engine") === "google_flights")!;
    expect(flight.searchParams.get("departure_id")).toBe("BOS");
    expect(flight.searchParams.get("arrival_id")).toBe("CLT");
    expect(prices.get(1)!.sources.transport.kind).toBe("live");
    expect(prices.get(1)!.sources.lodging.kind).toBe("live");
    // maya drives from raleigh: no flight search for her
    expect(prices.get(2)!.transportMode).toBe("drive");
  });

  it("no airport nearby: lodging can be live, flights stay estimates, no bad search", async () => {
    const { d, urls } = deps("k");
    const prices = await priceOption(porto, members, DATES, "budget", d);
    expect(urls.some((u) => u.searchParams.get("engine") === "google_flights")).toBe(false);
    expect(prices.get(1)!.sources.transport.kind).toBe("estimate");
    expect(prices.get(1)!.sources.lodging.kind).toBe("live");
  });

  it("no key: estimates only, no network", async () => {
    const { d, urls } = deps(undefined);
    const prices = await priceOption(boone, members, DATES, "budget", d);
    expect(urls).toHaveLength(0);
    expect(prices.get(1)!.sources.transport.kind).toBe("estimate");
    expect(prices.get(1)!.totalCents).toBeGreaterThan(0);
  });

  it("liveFlightFares: one search per origin, fare split per flyer", async () => {
    const { d, urls } = deps("k");
    const fares = await liveFlightFares("CLT", [{ personId: 1, originIata: "BOS" }, { personId: 3, originIata: "BOS" }], DATES, d);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.get("adults")).toBe("2");
    const total = cheapestFlightUsd(flightsRdu)!;
    expect(fares.get(1)!.cents).toBe(Math.round((total * 100) / 2));
    expect(fares.get(3)!.cents).toBe(fares.get(1)!.cents);
  });

  it("liveFlightFares with no arrival airport does nothing", async () => {
    const { d, urls } = deps("k");
    expect((await liveFlightFares("", [{ personId: 1, originIata: "BOS" }], DATES, d)).size).toBe(0);
    expect(urls).toHaveLength(0);
  });
});
