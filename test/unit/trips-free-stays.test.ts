// Keyless stay prices (Xotelo hotels, Airbnb rentals) from trimmed real responses: parsing, the
// fallback order behind SerpApi, caching, and that nothing calls out unless freeStays is set.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import xoteloList from "../fixtures/xotelo/list_asheville.json" with { type: "json" };
import xoteloRates from "../fixtures/xotelo/rates_cambria_asheville.json" with { type: "json" };
import hotelsChs from "../fixtures/serpapi/google_hotels_charleston.json" with { type: "json" };
import { destinationById, destinations, type Destination } from "../../src/trips/catalog.ts";
import {
  airbnbPlace,
  airbnbRentals,
  airbnbSearchUrl,
  airbnbStayUsd,
  cheapestXoteloRate,
  parseAirbnbPage,
  parseXoteloList,
  tripadvisorGeo,
  xoteloHotels,
} from "../../src/trips/freeStays.ts";
import { priceOption, type PriceCache, type PriceDeps } from "../../src/trips/pricing.ts";
import { findStays, setStayFixture } from "../../src/trips/stays.ts";

const airbnbHtml = readFileSync(new URL("../fixtures/airbnb/search_asheville.html", import.meta.url), "utf8");
const NOW = new Date("2026-10-11T12:00:00Z");
const DATES = { start: "2026-11-13", end: "2026-11-15" };
const asheville = destinationById("asheville")!;

class MemoryCache implements PriceCache {
  entries = new Map<string, { body: unknown; fetchedAt: Date }>();
  async get(key: string) {
    return this.entries.get(key);
  }
  async set(key: string, body: unknown, at: Date) {
    this.entries.set(key, { body, fetchedAt: at });
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Xotelo, Airbnb and Wikidata as the fixtures answer them; anything else is a 404. */
function freeResponder(url: URL): Response {
  if (url.host === "data.xotelo.com" && url.pathname === "/api/list") return json(xoteloList);
  if (url.host === "data.xotelo.com" && url.pathname === "/api/rates") return json(xoteloRates);
  if (url.host === "www.airbnb.com") return new Response(airbnbHtml, { headers: { "content-type": "text/html" } });
  if (url.host === "query.wikidata.org") return json({ results: { bindings: [{ ta: { type: "literal", value: "60742" } }] } });
  return new Response("not found", { status: 404 });
}

function setup(respond: (url: URL) => Response = freeResponder, overrides: Partial<PriceDeps> = {}) {
  const calls: URL[] = [];
  const cache = new MemoryCache();
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    return respond(url);
  }) as typeof fetch;
  const deps: PriceDeps = { fetch: fakeFetch, cache, now: () => NOW, freeStays: true, ...overrides };
  return { calls, cache, deps };
}

describe("catalog", () => {
  it("every destination carries a TripAdvisor geo id", () => {
    for (const d of destinations()) expect(d.tripadvisorGeo, d.id).toMatch(/^g\d+$/);
  });
});

describe("xotelo parsing", () => {
  it("lists hotels with their keys, ratings and coordinates", () => {
    const hotels = parseXoteloList(xoteloList);
    expect(hotels).toHaveLength(3);
    expect(hotels[0]).toMatchObject({ key: "g60742-d12654219", name: "Cambria Hotel Downtown Asheville", rating: 4.7 });
    expect(hotels[0]!.link).toMatch(/^https:\/\/www\.tripadvisor\.com\/Hotel_Review-g60742-d12654219/);
    expect(parseXoteloList({ error: { status_code: 401 }, result: null })).toEqual([]);
  });

  it("takes the cheapest site's nightly rate, tax included when given", () => {
    expect(cheapestXoteloRate(xoteloRates)).toEqual({ rate: 272, site: "Agoda.com" });
    expect(cheapestXoteloRate({ result: { rates: [{ name: "A", rate: 100, tax: 20 }, { name: "B", rate: 110, tax: null }] } })).toEqual({ rate: 110, site: "B" });
    expect(cheapestXoteloRate({ result: { rates: [] } })).toBeUndefined();
  });
});

describe("airbnb parsing", () => {
  const opts = { nights: 2, start: DATES.start, end: DATES.end, adults: 4 };

  it("reads whole places from the page's embedded search results, dropping private rooms", () => {
    const rentals = parseAirbnbPage(airbnbHtml, opts);
    expect(rentals.map((r) => r.name)).toEqual(["Robin’s Nest Retreat", "Holy Shiplap", "Near Asheville Downtown, 2 BDR Mountain Retreat"]);
    expect(rentals[0]).toMatchObject({ kind: "Cabin in Weaverville", totalUsd: 665, rating: 4.98, reviews: 60, lat: 35.78321, lon: -82.54801 });
    expect(rentals[0]!.link).toBe("https://www.airbnb.com/rooms/1399200502507274321?check_in=2026-11-13&check_out=2026-11-15&adults=4");
    expect(rentals[1]!.totalUsd).toBe(226);
  });

  it("reads totals and nightly prices", () => {
    expect(airbnbStayUsd("$1,234 for 3 nights, originally $1,400", 3)).toBe(1234);
    expect(airbnbStayUsd("$120 per night", 3)).toBe(360);
    expect(airbnbStayUsd("$95 night", 2)).toBe(190);
    expect(airbnbStayUsd("Price unavailable", 2)).toBeUndefined();
  });

  it("returns nothing for a page without results", () => {
    expect(parseAirbnbPage("<html><body>Please enable JS</body></html>", opts)).toEqual([]);
  });

  it("searches a map box around the destination", () => {
    expect(airbnbPlace(asheville)).toBe("Asheville, NC");
    const url = new URL(airbnbSearchUrl("Asheville, NC", DATES.start, DATES.end, 4, { lat: 35.5951, lon: -82.5515 }));
    expect(url.pathname).toBe("/s/Asheville%2C%20NC/homes");
    expect(url.searchParams.get("adults")).toBe("4");
    expect(Number(url.searchParams.get("ne_lat"))).toBeGreaterThan(35.5951);
    expect(Number(url.searchParams.get("sw_lng"))).toBeLessThan(-82.5515);
  });
});

describe("fetching", () => {
  it("prices the listed hotels for the dates, one rates call each, cached", async () => {
    const { calls, cache, deps } = setup();
    const result = await xoteloHotels(asheville, DATES, 2, deps);
    expect(result!.hotels).toHaveLength(3);
    expect(result!.hotels[0]).toMatchObject({ name: "Cambria Hotel Downtown Asheville", roomTotalUsd: 544, site: "Agoda.com" });
    expect(calls.map((u) => u.pathname)).toEqual(["/api/list", "/api/rates", "/api/rates", "/api/rates"]);
    expect(calls[1]!.searchParams.get("chk_in")).toBe(DATES.start);
    calls.length = 0;
    await xoteloHotels(asheville, DATES, 2, deps);
    expect(calls).toEqual([]);
    expect([...cache.entries.keys()].every((k) => k.startsWith("xotelo:"))).toBe(true);
  });

  it("looks up an off-catalog place's geo on Wikidata, once", async () => {
    const { calls, deps } = setup();
    const town = { ...asheville, id: "weaverville", name: "Weaverville", tripadvisorGeo: undefined } as Destination;
    expect(await tripadvisorGeo(town, deps)).toBe("g60742");
    expect(await tripadvisorGeo(town, deps)).toBe("g60742");
    expect(calls.filter((u) => u.host === "query.wikidata.org")).toHaveLength(1);
  });

  it("caches parsed Airbnb listings, not the page", async () => {
    const { cache, deps } = setup();
    const result = await airbnbRentals(asheville, DATES, 2, 4, deps);
    expect(result!.rentals).toHaveLength(3);
    const [entry] = [...cache.entries.values()];
    expect(Array.isArray(entry!.body)).toBe(true);
  });

  it("gives up quietly when the sources refuse", async () => {
    const { deps } = setup(() => new Response("blocked", { status: 403 }));
    expect(await xoteloHotels(asheville, DATES, 2, deps)).toBeUndefined();
    expect(await airbnbRentals(asheville, DATES, 2, 4, deps)).toBeUndefined();
  });
});

describe("behind SerpApi", () => {
  it("findStays uses Xotelo and Airbnb when there is no SerpApi key, with a hotel among the picks", async () => {
    setStayFixture(undefined);
    const { deps } = setup();
    const { options, live } = await findStays(asheville, DATES, 4, null, deps);
    expect(live).toBe(true);
    expect(options).toHaveLength(3);
    expect(options.some((o) => o.via === "xotelo" && o.kind === "hotel" && o.rooms === 2)).toBe(true);
    expect(options.some((o) => o.via === "airbnb" && o.kind === "rental")).toBe(true);
    const shiplap = options.find((o) => o.name === "Holy Shiplap")!;
    expect(shiplap).toMatchObject({ totalCents: 22_600, perPersonCents: 5_650, perPersonNightCents: 2_825 });
  });

  it("SerpApi answers win; only the half it missed goes to a keyless source", async () => {
    setStayFixture(undefined);
    const { calls, deps } = setup((url) => {
      if (url.host === "serpapi.com") return url.searchParams.get("vacation_rentals") ? json({ error: "no results" }) : json(hotelsChs);
      return freeResponder(url);
    }, { apiKey: "test-key" });
    const charleston = destinationById("charleston")!;
    const { options } = await findStays(charleston, DATES, 3, null, deps);
    expect(calls.some((u) => u.host === "data.xotelo.com")).toBe(false);
    expect(calls.some((u) => u.host === "www.airbnb.com")).toBe(true);
    expect(options.filter((o) => o.kind === "hotel").every((o) => o.via === undefined)).toBe(true);
  });

  it("priceOption takes lodging from Xotelo without a key, labelled", async () => {
    const { deps } = setup();
    const prices = await priceOption(asheville, [{ personId: 1, name: "maya", homeAirport: "AVL", dietary: [], vetoes: [] }], DATES, "budget", deps);
    const maya = prices.get(1)!;
    // Median of the three room totals ($544 each, the same fixture) for two, halved.
    expect(maya.lodgingCents).toBe(27_200);
    expect(maya.sources.lodging).toMatchObject({ kind: "live", detail: "tripadvisor hotel rates via xotelo" });
  });

  it("never calls out when freeStays is off", async () => {
    setStayFixture(undefined);
    const { calls, deps } = setup(freeResponder, { freeStays: false });
    const { live } = await findStays(asheville, DATES, 4, null, deps);
    await priceOption(asheville, [{ personId: 1, name: "maya", homeAirport: "AVL", dietary: [], vetoes: [] }], DATES, "budget", deps);
    expect(live).toBe(false);
    expect(calls).toEqual([]);
  });
});
