// Food & activities around the stay: parsing SerpApi google_maps results, price levels as words,
// dietary filtering, interest ranking, distances, the client (cache, timeout, fallback), and
// putting picks on the itinerary.
import { describe, expect, it } from "vitest";
import restaurants from "../fixtures/serpapi/google_maps_asheville_restaurants.json" with { type: "json" };
import things from "../fixtures/serpapi/google_maps_asheville_things_to_do.json" with { type: "json" };
import {
  catalogPlaces,
  dietFit,
  distanceMeters,
  distanceText,
  failsDiet,
  foodQuery,
  mapsSearchParams,
  parseMapsResults,
  placeFacts,
  priceLevelOf,
  rankPlaces,
  searchNearby,
  settingOf,
  travelMinutes,
  type NearbyPlace,
} from "../../src/trips/nearby.ts";
import { cacheKey, type PriceCache, type PriceDeps } from "../../src/trips/pricing.ts";
import { destinationById } from "../../src/trips/catalog.ts";
import { parseMoneyMentions } from "../../src/money/cents.ts";
import { itineraryInput } from "../../src/site/content.ts";
import { dietNote, placeOnItinerary, placesNamedIn, resolvePlace, shortlistLine, splitRefs } from "../../src/agent/features/places.ts";
import type { TripPlaceRow } from "../../src/trips/placesStore.ts";

const STAY = { lat: 35.5935, lon: -82.5536 };
const NOW = new Date("2026-10-10T18:00:00Z");

function memoryCache(): PriceCache & { map: Map<string, { body: unknown; fetchedAt: Date }> } {
  const map = new Map<string, { body: unknown; fetchedAt: Date }>();
  return { map, get: async (k) => map.get(k), set: async (k, body, at) => void map.set(k, { body, fetchedAt: at }) };
}

describe("google_maps parsing", () => {
  const food = parseMapsResults(restaurants, "food");

  it("reads every local result with its coordinates, rating, reviews, category and price level", () => {
    expect(food).toHaveLength(11);
    const chai = food.find((p) => p.name === "Chai Pani")!;
    expect(chai).toMatchObject({
      kind: "food",
      source: "serpapi",
      sourceId: "ChIJfixturechaipani",
      category: "Indian restaurant",
      address: "22 Battery Park Ave, Asheville, NC 28801",
      lat: 35.5958,
      lon: -82.5555,
      rating: 4.7,
      reviews: 4876,
      priceLevel: 2,
    });
    expect(chai.types).toEqual(["Indian restaurant", "Vegetarian restaurant"]);
  });

  it("skips results with no name or id and handles a single place_results", () => {
    expect(parseMapsResults({ local_results: [{ title: "No id" }, { place_id: "x" }] }, "food")).toEqual([]);
    expect(parseMapsResults({ place_results: { title: "Solo", place_id: "p1", rating: 4.2 } }, "activity")).toMatchObject([{ name: "Solo", rating: 4.2 }]);
    expect(parseMapsResults({ error: "nope" }, "food")).toEqual([]);
    expect(parseMapsResults(null, "food")).toEqual([]);
  });

  it("turns $$ and per-person ranges into a 1–4 level", () => {
    expect(priceLevelOf("$")).toBe(1);
    expect(priceLevelOf("$$")).toBe(2);
    expect(priceLevelOf("$$$$")).toBe(4);
    expect(priceLevelOf("$10–20")).toBe(2);
    expect(priceLevelOf("$1–10")).toBe(1);
    expect(priceLevelOf("$30–50")).toBe(3);
    expect(priceLevelOf("$50–100")).toBe(4);
    expect(priceLevelOf("$100+")).toBe(4);
    expect(priceLevelOf(undefined)).toBeUndefined();
    expect(priceLevelOf("cheap")).toBeUndefined();
  });

  it("never shows a price as a dollar figure (money guard and page rule)", () => {
    for (const p of food) {
      const line = shortlistLine(1, { ...p, distanceM: 400 });
      expect(line).not.toContain("$");
      expect(parseMoneyMentions(line)).toEqual([]);
    }
    expect(placeFacts({ rating: 4.5, priceLevel: 3, distanceM: 300 })).toBe("4.5★, pricey, 5 min walk");
  });

  it("builds the search around the stay", () => {
    expect(mapsSearchParams("restaurants", STAY)).toEqual({ engine: "google_maps", type: "search", q: "restaurants", ll: "@35.5935,-82.5536,14z", hl: "en", gl: "us" });
  });
});

describe("distance", () => {
  it("walks short hops and drives longer ones", () => {
    expect(distanceMeters(STAY, { lat: 35.5958, lon: -82.5555 })).toBeGreaterThan(250);
    expect(travelMinutes(400)).toEqual({ mode: "walk", minutes: 7 });
    expect(travelMinutes(1_200)).toEqual({ mode: "walk", minutes: 20 });
    expect(travelMinutes(2_000).mode).toBe("drive");
    expect(travelMinutes(6_000)).toEqual({ mode: "drive", minutes: 17 });
    expect(distanceText(undefined)).toBeUndefined();
    expect(distanceText(100)).toBe("2 min walk");
  });
});

describe("dietary filtering", () => {
  const food = parseMapsResults(restaurants, "food");
  const veg = new Set(["vegetarian"]);

  it("drops steakhouses and barbecue for vegetarians but keeps veg-friendly places", () => {
    const names = (s: Set<string>) => food.filter((p) => !failsDiet(p, s)).map((p) => p.name);
    expect(names(veg)).not.toContain("Ruth's Chris Steak House");
    expect(names(veg)).not.toContain("Buxton Hall Barbecue");
    expect(names(veg)).toContain("Chai Pani");
    expect(names(new Set())).toContain("Buxton Hall Barbecue");
    expect(names(new Set(["halal"]))).not.toContain("Buxton Hall Barbecue");
    expect(names(new Set(["pescatarian"]))).not.toContain("Ruth's Chris Steak House");
  });

  it("scores places built for a need higher", () => {
    expect(dietFit(food.find((p) => p.name === "Laughing Seed Café")!, veg)).toBe(1);
    expect(dietFit(food.find((p) => p.name === "Mamacita's Taqueria")!, veg)).toBe(0);
    expect(dietFit(food.find((p) => p.name === "Plant")!, new Set(["vegan"]))).toBe(1);
  });

  it("asks the map for the strictest need anyone has", () => {
    expect(foodQuery([])).toBe("restaurants");
    expect(foodQuery(["gluten_free", "vegetarian"])).toBe("vegetarian friendly restaurants");
    expect(foodQuery(["vegetarian", "vegan"])).toBe("vegan friendly restaurants");
    expect(foodQuery(["vegetarian"], "tacos")).toBe("tacos restaurants");
  });

  it("ranks a vegetarian shortlist: five places, none that fail, low ratings out, distances set", () => {
    const top = rankPlaces(food, { origin: STAY, dietary: ["vegetarian"] });
    expect(top).toHaveLength(5);
    expect(top.map((p) => p.name)).not.toContain("Late Night Grill");
    for (const p of top) {
      expect(failsDiet(p, veg)).toBe(false);
      expect(p.distanceM).toBeGreaterThan(0);
    }
    expect(top.map((p) => p.name)).toContain("Laughing Seed Café");
  });

  it("names who each need is for", () => {
    expect(dietNote(new Map([["vegetarian", ["maya"]], ["gluten_free", ["leo", "sam"]]]))).toBe(" (vegetarian-friendly for maya, gluten-free for leo and sam)");
    expect(dietNote(new Map())).toBe("");
  });
});

describe("things to do", () => {
  const acts = parseMapsResults(things, "activity");

  it("leans into what people like and away from what they don't", () => {
    const music = rankPlaces(acts, { origin: STAY, interests: { music: 2 } });
    expect(music[0]!.name).toBe("The Orange Peel");
    const noHikes = rankPlaces(acts, { origin: STAY, interests: { hiking: -2 } }).map((p) => p.name);
    expect(noHikes).not.toContain("Craggy Gardens Trail");
  });

  it("knows outdoor from indoor", () => {
    expect(settingOf(acts.find((p) => p.name === "Craggy Gardens Trail")!)).toBe("outdoor");
    expect(settingOf(acts.find((p) => p.name === "Asheville Pinball Museum")!)).toBe("indoor");
  });

  it("falls back to the catalog's activities offline", () => {
    const dest = destinationById("asheville")!;
    const offline = catalogPlaces(dest, "activity");
    expect(offline.length).toBe(dest.activities.length);
    expect(offline[0]).toMatchObject({ source: "catalog", sourceId: `catalog:${dest.activities[0]!.id}` });
    expect(catalogPlaces(dest, "food").every((p) => p.tags!.includes("food"))).toBe(true);
  });
});

describe("the client", () => {
  const deps = (over: Partial<PriceDeps> = {}): PriceDeps => ({ apiKey: "test-key", fetch: (async () => new Response(JSON.stringify(restaurants))) as typeof fetch, cache: memoryCache(), now: () => NOW, ...over });

  it("searches, parses, ranks and caches (never with the key in the cache key)", async () => {
    const cache = memoryCache();
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(restaurants));
    }) as unknown as typeof fetch;
    const r = await searchNearby("food", { ...STAY, label: "the hotel" }, { dietary: ["vegetarian"] }, deps({ cache, fetch: fetchFn }));
    expect(r.source).toBe("serpapi");
    expect(r.query).toBe("vegetarian friendly restaurants");
    expect(r.places).toHaveLength(5);
    expect(new URL(urls[0]!).searchParams.get("engine")).toBe("google_maps");
    expect([...cache.map.keys()]).toEqual([cacheKey(mapsSearchParams("vegetarian friendly restaurants", STAY))]);
    expect([...cache.map.keys()][0]).not.toContain("test-key");
    // Second time from the cache.
    await searchNearby("food", { ...STAY, label: "the hotel" }, { dietary: ["vegetarian"] }, deps({ cache, fetch: fetchFn }));
    expect(urls).toHaveLength(1);
  });

  it("falls back to the catalog with no key, on errors and on timeouts", async () => {
    const dest = destinationById("asheville")!;
    const noKey = await searchNearby("activity", { ...STAY, label: "x" }, { dest }, deps({ apiKey: undefined }));
    expect(noKey.source).toBe("catalog");
    expect(noKey.places.length).toBe(5);
    const broken = await searchNearby("activity", { ...STAY, label: "x" }, { dest }, deps({ fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch }));
    expect(broken.source).toBe("catalog");
    const slow = await searchNearby(
      "activity",
      { ...STAY, label: "x" },
      { dest },
      deps({ timeoutMs: 20, fetch: ((_u: string, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch }),
    );
    expect(slow.source).toBe("catalog");
    const nothing = await searchNearby("food", { ...STAY, label: "x" }, {}, deps({ apiKey: undefined }));
    expect(nothing).toEqual({ places: [], source: "none", query: "restaurants" });
  });
});

const row = (over: Partial<TripPlaceRow>): TripPlaceRow => ({
  id: 1,
  trip_id: 1,
  kind: "food",
  idx: 1,
  name: "Chai Pani",
  category: null,
  address: null,
  lat: null,
  lon: null,
  rating: null,
  reviews: null,
  price_level: null,
  distance_m: null,
  source: "serpapi",
  source_id: "a",
  status: "suggested",
  picked_by: null,
  picked_at: null,
  day: null,
  added_at: NOW,
  ...over,
});

describe("picking", () => {
  const rows = [
    row({ id: 1, idx: 1, name: "Chai Pani", source_id: "a" }),
    row({ id: 2, idx: 2, name: "Tupelo Honey Southern Kitchen & Bar", source_id: "b" }),
    row({ id: 3, idx: 6, kind: "activity", name: "The Orange Peel", source_id: "c" }),
    row({ id: 4, idx: 7, kind: "activity", name: "Biltmore Estate", source_id: "d" }),
  ];

  it("resolves numbers and names (partial, accents, 'the')", () => {
    expect(resolvePlace("1", rows)?.id).toBe(1);
    expect(resolvePlace("#6", rows)?.id).toBe(3);
    expect(resolvePlace("20", rows)).toBeUndefined();
    expect(resolvePlace("chai pani", rows)?.id).toBe(1);
    expect(resolvePlace("tupelo honey", rows)?.id).toBe(2);
    expect(resolvePlace("orange peel", rows)?.id).toBe(3);
    expect(resolvePlace("the biltmore estate", rows)?.id).toBe(4);
    expect(resolvePlace("gas", rows)).toBeUndefined();
  });

  it("splits lists and finds places named in a sentence", () => {
    expect(splitRefs("1 and 6")).toEqual(["1", "6"]);
    expect(splitRefs("2, 7 & chai pani")).toEqual(["2", "7", "chai pani"]);
    expect(placesNamedIn("chai pani looks so good", rows).map((r) => r.id)).toEqual([1]);
    expect(placesNamedIn("tupelo honey for brunch?", rows).map((r) => r.id)).toEqual([2]);
    expect(placesNamedIn("let's eat somewhere", rows)).toEqual([]);
  });

  it("puts food at dinner on the emptiest day and activities on middle days first", () => {
    const trip = { start: "2026-11-12", end: "2026-11-15" };
    const food = { kind: "food" as const, activityId: "place:food:a", name: "Chai Pani", setting: "indoor" as const, notes: "4.7★, mid-range" };
    const a = placeOnItinerary([], trip, food)!;
    expect(a.date).toBe("2026-11-12");
    expect(a.time).toBe("dinner");
    expect(a.itinerary).toHaveLength(4);
    const b = placeOnItinerary(a.itinerary, trip, { ...food, activityId: "place:food:b", name: "Plant" })!;
    expect(b.date).toBe("2026-11-13");
    const act = placeOnItinerary(b.itinerary, trip, { kind: "activity", activityId: "place:activity:c", name: "The Orange Peel", setting: "indoor" })!;
    expect(act.date).toBe("2026-11-13");
    expect(act.time).toBe("morning");
    const act2 = placeOnItinerary(act.itinerary, trip, { kind: "activity", activityId: "place:activity:d", name: "Biltmore", setting: "either" })!;
    expect(act2.date).toBe("2026-11-14");
    // What lands on the plan passes the page's own validation.
    for (const d of act2.itinerary) {
      const parsed = itineraryInput.safeParse({ days: [{ date: d.date, items: d.items.map((i) => ({ name: i.name, setting: i.setting, time: i.time, notes: i.notes })) }] });
      expect(parsed.success).toBe(true);
    }
  });

  it("returns null when every day is full", () => {
    const full = [{ date: "2026-11-12", items: Array.from({ length: 8 }, (_, i) => ({ activityId: `x${i}`, name: `x${i}`, setting: "indoor" as const, costCents: 0 })) }];
    expect(placeOnItinerary(full, { start: "2026-11-12", end: "2026-11-12" }, { kind: "food", activityId: "f", name: "f", setting: "indoor" })).toBeNull();
  });
});

// Keep the type import used.
export type _P = NearbyPlace;
