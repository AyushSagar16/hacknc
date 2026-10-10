// Live pricing over SerpApi with fixtures: grouping by origin, cache freshness, and estimate
// fallback on every kind of failure. No network.
import { describe, expect, it } from "vitest";
import flightsRduSju from "../fixtures/serpapi/google_flights_rdu_sju.json" with { type: "json" };
import flightsJfkSju from "../fixtures/serpapi/google_flights_jfk_sju.json" with { type: "json" };
import hotelsSanJuan from "../fixtures/serpapi/google_hotels_san_juan.json" with { type: "json" };
import { findDestination, type Destination } from "../../src/trips/catalog.ts";
import { estimateCost } from "../../src/trips/estimate.ts";
import type { MemberConstraints } from "../../src/trips/filter.ts";
import { googleFlightsLink, googleHotelsLink } from "../../src/trips/links.ts";
import {
  cacheKey,
  cheapestFlightUsd,
  flightSearchParams,
  hotelSearchParams,
  lodgingPerPersonUsd,
  priceOption,
  type PriceCache,
  type PriceDeps,
} from "../../src/trips/pricing.ts";

const NOW = new Date("2026-10-10T15:00:00Z");
const DATES = { start: "2027-03-06", end: "2027-03-10" };
const KEY = "test-serpapi-key";

function dest(id: string): Destination {
  const d = findDestination(id);
  if (!d) throw new Error(`no destination ${id}`);
  return d;
}

const sanJuan = dest("san-juan");
const members: MemberConstraints[] = [
  { personId: 1, name: "maya", homeAirport: "RDU", dietary: [], vetoes: [] },
  { personId: 2, name: "leo", homeAirport: "Chapel Hill", dietary: [], vetoes: [] },
  { personId: 3, name: "priya", homeAirport: "JFK", dietary: [], vetoes: [] },
];

class MemoryCache implements PriceCache {
  entries = new Map<string, { body: unknown; fetchedAt: Date }>();
  sets: string[] = [];
  async get(key: string) {
    return this.entries.get(key);
  }
  async set(key: string, body: unknown, at: Date) {
    this.sets.push(key);
    this.entries.set(key, { body, fetchedAt: at });
  }
}

type Responder = (url: URL) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fixtureResponder(url: URL): Response {
  const engine = url.searchParams.get("engine");
  if (engine === "google_hotels") return json(hotelsSanJuan);
  if (engine === "google_flights" && url.searchParams.get("departure_id") === "RDU") return json(flightsRduSju);
  if (engine === "google_flights" && url.searchParams.get("departure_id") === "JFK") return json(flightsJfkSju);
  return json({ error: "Google Flights hasn't returned any results for this query." });
}

function setup(respond: Responder = fixtureResponder, overrides: Partial<PriceDeps> = {}) {
  const calls: URL[] = [];
  const cache = new MemoryCache();
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    return respond(url);
  }) as typeof fetch;
  const deps: PriceDeps = { apiKey: KEY, fetch: fakeFetch, cache, now: () => NOW, ...overrides };
  return { calls, cache, deps };
}

function estimates(d: Destination, tier: "budget" | "mid" = "budget") {
  return new Map(members.map((m) => [m.personId, estimateCost(d, m, 4, tier, members.length)]));
}

describe("response parsing", () => {
  it("takes the cheapest price across best_flights and other_flights", () => {
    expect(cheapestFlightUsd(flightsRduSju)).toBe(560);
    expect(cheapestFlightUsd(flightsJfkSju)).toBe(389);
    expect(cheapestFlightUsd({ price_insights: { lowest_price: 444 } })).toBe(444);
    expect(cheapestFlightUsd({ error: "nope" })).toBeUndefined();
  });

  it("per-person lodging is the median of the five cheapest room totals, halved", () => {
    // Totals 420, 468, 512, 520 (130/night × 4), 560 → median 512 → 256 each.
    expect(lodgingPerPersonUsd(hotelsSanJuan, "budget", 4)).toBe(256);
    // Mid uses the median of everything priced: (560 + 604) / 2 / 2.
    expect(lodgingPerPersonUsd(hotelsSanJuan, "mid", 4)).toBe(291);
    expect(lodgingPerPersonUsd({ properties: [] }, "budget", 4)).toBeUndefined();
  });

  it("builds the documented search parameters", () => {
    expect(flightSearchParams("RDU", "SJU", DATES.start, DATES.end, 2)).toEqual({
      engine: "google_flights", departure_id: "RDU", arrival_id: "SJU", outbound_date: "2027-03-06", return_date: "2027-03-10",
      type: "1", adults: "2", currency: "USD", hl: "en", gl: "us", sort_by: "2",
    });
    expect(hotelSearchParams("San Juan", DATES.start, DATES.end)).toMatchObject({
      engine: "google_hotels", q: "San Juan hotels", check_in_date: "2027-03-06", check_out_date: "2027-03-10", adults: "2",
    });
    expect(cacheKey({ b: "2", a: "1", api_key: "secret" })).toBe("serpapi:a=1&b=2");
  });
});

describe("priceOption", () => {
  it("prices flights per origin and hotels once, labelled live", async () => {
    const { calls, cache, deps } = setup();
    const prices = await priceOption(sanJuan, members, DATES, "budget", deps);

    expect(calls).toHaveLength(3);
    const flights = calls.filter((u) => u.searchParams.get("engine") === "google_flights");
    expect(flights.map((u) => [u.searchParams.get("departure_id"), u.searchParams.get("adults")]).sort()).toEqual([["JFK", "1"], ["RDU", "2"]]);
    for (const u of calls) {
      expect(u.origin + u.pathname).toBe("https://serpapi.com/search.json");
      expect(u.searchParams.get("api_key")).toBe(KEY);
    }
    expect(cache.sets).toHaveLength(3);
    for (const key of cache.sets) expect(key).not.toContain(KEY);

    const maya = prices.get(1)!;
    const leo = prices.get(2)!;
    const priya = prices.get(3)!;
    expect(maya.transportCents).toBe(28_000); // $560 for two adults
    expect(leo.transportCents).toBe(28_000);
    expect(priya.transportCents).toBe(38_900);
    for (const b of [maya, leo, priya]) {
      expect(b.lodgingCents).toBe(25_600);
      expect(b.sources.transport).toEqual({ kind: "live", detail: "google flights via serpapi", checkedAt: NOW.toISOString() });
      expect(b.sources.lodging).toEqual({ kind: "live", detail: "google hotels via serpapi", checkedAt: NOW.toISOString() });
      expect(b.sources.food.kind).toBe("estimate");
      expect(b.totalCents).toBe(b.transportCents + b.lodgingCents + b.foodCents + b.activitiesCents + b.localCents);
    }
    expect(maya.foodCents).toBe(estimates(sanJuan).get(1)!.foodCents);
  });

  it("uses the mid-tier hotel median for mid trips", async () => {
    const { deps } = setup();
    const prices = await priceOption(sanJuan, members, DATES, "mid", deps);
    expect(prices.get(1)!.lodgingCents).toBe(29_100);
  });

  it("serves fresh cache hits without fetching", async () => {
    const first = setup();
    await priceOption(sanJuan, members, DATES, "budget", first.deps);
    const fetchedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const cache = new MemoryCache();
    for (const [k, v] of first.cache.entries) cache.entries.set(k, { body: v.body, fetchedAt });

    const second = setup(fixtureResponder, { cache });
    const prices = await priceOption(sanJuan, members, DATES, "budget", second.deps);
    expect(second.calls).toHaveLength(0);
    expect(prices.get(3)!.transportCents).toBe(38_900);
    expect(prices.get(3)!.sources.transport.checkedAt).toBe(fetchedAt.toISOString());
  });

  it("uses the cache even without an API key, and refetches stale entries", async () => {
    const warm = setup();
    await priceOption(sanJuan, members, DATES, "budget", warm.deps);

    const keyless = setup(fixtureResponder, { apiKey: undefined, cache: warm.cache });
    const prices = await priceOption(sanJuan, members, DATES, "budget", keyless.deps);
    expect(keyless.calls).toHaveLength(0);
    expect(prices.get(1)!.sources.transport.kind).toBe("live");

    const later = setup(fixtureResponder, { cache: warm.cache, now: () => new Date(NOW.getTime() + 13 * 60 * 60 * 1000) });
    await priceOption(sanJuan, members, DATES, "budget", later.deps);
    expect(later.calls).toHaveLength(3);
  });

  it("falls back to labelled estimates when the network fails", async () => {
    const { deps } = setup(() => {
      throw new Error("ECONNRESET");
    });
    const prices = await priceOption(sanJuan, members, DATES, "budget", deps);
    expect(prices).toEqual(estimates(sanJuan));
    for (const b of prices.values()) {
      expect(Object.values(b.sources).every((s) => s.kind === "estimate")).toBe(true);
    }
  });

  it("falls back on HTTP errors and SerpApi error bodies, and doesn't cache them", async () => {
    const http = setup(() => json({ error: "Invalid API key." }, 401));
    expect(await priceOption(sanJuan, members, DATES, "budget", http.deps)).toEqual(estimates(sanJuan));
    expect(http.cache.sets).toEqual([]);

    const errorBody = setup(() => json({ error: "Your account has run out of searches." }));
    expect(await priceOption(sanJuan, members, DATES, "budget", errorBody.deps)).toEqual(estimates(sanJuan));
    expect(errorBody.cache.sets).toEqual([]);
  });

  it("times out slow searches", async () => {
    const { deps } = setup(() => new Promise<Response>(() => undefined), { timeoutMs: 20 });
    const started = Date.now();
    const prices = await priceOption(sanJuan, members, DATES, "budget", deps);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(prices).toEqual(estimates(sanJuan));
  });

  it("never calls out without an API key", async () => {
    const { calls, deps } = setup(fixtureResponder, { apiKey: undefined });
    expect(await priceOption(sanJuan, members, DATES, "budget", deps)).toEqual(estimates(sanJuan));
    expect(calls).toEqual([]);
  });

  it("replaces only the components that came back", async () => {
    const { deps } = setup((url) => (url.searchParams.get("engine") === "google_hotels" ? json({}, 500) : fixtureResponder(url)));
    const prices = await priceOption(sanJuan, members, DATES, "budget", deps);
    const maya = prices.get(1)!;
    expect(maya.sources.transport.kind).toBe("live");
    expect(maya.sources.lodging.kind).toBe("estimate");
    expect(maya.lodgingCents).toBe(estimates(sanJuan).get(1)!.lodgingCents);
  });

  it("never searches flights for drivers or non-flyers", async () => {
    const asheville = dest("asheville");
    const group: MemberConstraints[] = [
      { personId: 1, name: "maya", homeAirport: "RDU", dietary: [], vetoes: [] }, // 4h drive: drives
      { personId: 2, name: "sam", homeAirport: "ORD", noFlying: true, dietary: [], vetoes: [] },
      { personId: 3, name: "priya", homeAirport: "JFK", dietary: [], vetoes: [] },
    ];
    const { calls, deps } = setup((url) => json(url.searchParams.get("engine") === "google_hotels" ? hotelsSanJuan : flightsJfkSju));
    const prices = await priceOption(asheville, group, DATES, "budget", deps);
    const flights = calls.filter((u) => u.searchParams.get("engine") === "google_flights");
    expect(flights.map((u) => u.searchParams.get("departure_id"))).toEqual(["JFK"]);
    expect(prices.get(1)!.transportMode).toBe("drive");
    expect(prices.get(1)!.sources.transport.kind).toBe("estimate");
    expect(prices.get(2)!.transportMode).toBe("drive");
    expect(prices.get(3)!.sources.transport.kind).toBe("live");
  });
});

describe("booking links", () => {
  it("builds URL-encoded Google Travel q= links", () => {
    const flights = googleFlightsLink("RDU", "SJU", DATES.start, DATES.end);
    expect(flights).toBe("https://www.google.com/travel/flights?q=Flights%20to%20SJU%20from%20RDU%20on%202027-03-06%20through%202027-03-10");
    expect(new URL(flights).searchParams.get("q")).toBe("Flights to SJU from RDU on 2027-03-06 through 2027-03-10");

    const hotels = googleHotelsLink("Cancún", DATES.start, DATES.end, 4);
    expect(hotels.startsWith("https://www.google.com/travel/hotels?q=")).toBe(true);
    expect(new URL(hotels).searchParams.get("q")).toBe("Cancún hotels 2027-03-06 to 2027-03-10 for 4 adults");
    expect(new URL(googleHotelsLink("Tulum", DATES.start, DATES.end, 1)).searchParams.get("q")).toContain("for 1 adult");
  });
});
