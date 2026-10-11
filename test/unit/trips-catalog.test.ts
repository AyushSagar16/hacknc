// Data integrity for data/destinations.json and data/airports.json, plus name/home resolution.
import { describe, expect, it } from "vitest";
import {
  airports,
  destinations,
  DIETARY_NEEDS,
  findDestination,
  normalizeTag,
  ORIGIN_REGIONS,
  REGIONS,
  resolveHome,
  TAGS,
} from "../../src/trips/catalog.ts";

const all = destinations();
const tags = new Set<string>(TAGS);
const isCents = (n: unknown): boolean => typeof n === "number" && Number.isInteger(n) && n > 0;

describe("destinations.json", () => {
  it("has ~40 destinations with unique ids", () => {
    expect(all.length).toBeGreaterThanOrEqual(38);
    expect(new Set(all.map((d) => d.id)).size).toBe(all.length);
  });

  it.each(all.map((d) => [d.id, d] as const))("%s has every required field", (_id, d) => {
    expect(d.id).toMatch(/^[a-z0-9-]+$/);
    expect(d.name.length).toBeGreaterThan(0);
    expect(d.country.length).toBeGreaterThan(0);
    expect(REGIONS).toContain(d.region);
    expect(d.iata).toMatch(/^[A-Z]{3}$/);
    expect(Math.abs(d.lat)).toBeLessThanOrEqual(90);
    expect(Math.abs(d.lon)).toBeLessThanOrEqual(180);
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: d.timezone })).not.toThrow();
    expect(typeof d.passportRequired).toBe("boolean");
    expect(d.passportRequired).toBe(!["United States", "Puerto Rico"].includes(d.country));

    expect(d.tags.length).toBeGreaterThan(0);
    for (const t of d.tags) expect(tags.has(t), `${d.id} tag ${t}`).toBe(true);

    for (const need of DIETARY_NEEDS) {
      expect(d.dietary[need]).toBeGreaterThanOrEqual(0);
      expect(d.dietary[need]).toBeLessThanOrEqual(1);
    }

    for (const m of [...d.bestMonths, ...d.badMonths]) expect(m >= 1 && m <= 12).toBe(true);
    expect(d.bestMonths.filter((m) => d.badMonths.includes(m))).toEqual([]);
    for (const m of d.badMonths) expect(d.badMonthReasons?.[String(m)], `${d.id} month ${m}`).toBeTruthy();

    const c = d.costs;
    for (const tier of ["budget", "mid"] as const) {
      expect(isCents(c.lodgingPerNightCents[tier])).toBe(true);
      expect(isCents(c.foodPerDayCents[tier])).toBe(true);
      expect(isCents(c.activitiesPerDayCents[tier])).toBe(true);
    }
    expect(c.lodgingPerNightCents.mid).toBeGreaterThan(c.lodgingPerNightCents.budget);
    expect(isCents(c.localTransportPerDayCents)).toBe(true);

    for (const origin of ORIGIN_REGIONS) {
      const band = d.flightFromRegion[origin];
      expect(band, `${d.id} from ${origin}`).toBeDefined();
      const [low, high] = band!.roundTripCents;
      expect(isCents(low) && isCents(high)).toBe(true);
      expect(high).toBeGreaterThan(low);
      expect(band!.hours).toBeGreaterThan(0);
    }
    for (const [origin, hours] of Object.entries(d.driveFromRegion ?? {})) {
      expect(ORIGIN_REGIONS).toContain(origin);
      expect(hours).toBeGreaterThanOrEqual(0);
      expect(hours).toBeLessThanOrEqual(10);
    }

    expect(d.activities.length).toBeGreaterThanOrEqual(6);
    expect(d.activities.length).toBeLessThanOrEqual(9);
    for (const a of d.activities) {
      expect(a.id.startsWith(`${d.id}-`)).toBe(true);
      expect(a.name.length).toBeGreaterThan(0);
      expect(["outdoor", "indoor", "either"]).toContain(a.setting);
      expect(["easy", "moderate", "strenuous"]).toContain(a.mobility);
      expect(Number.isInteger(a.costCents) && a.costCents >= 0).toBe(true);
      expect(a.durationHours).toBeGreaterThan(0);
      expect(a.tags.length).toBeGreaterThan(0);
      for (const t of a.tags) expect(tags.has(t), `${a.id} tag ${t}`).toBe(true);
    }
  });

  it("activity ids are unique across the catalog", () => {
    const ids = all.flatMap((d) => d.activities.map((a) => a.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every beach destination has at least one indoor rainy-day activity", () => {
    for (const d of all.filter((x) => x.tags.includes("beach"))) {
      expect(d.activities.some((a) => a.setting === "indoor"), d.id).toBe(true);
    }
  });

  it("only drivable places have drive times", () => {
    for (const id of ["honolulu", "san-juan", "nassau", "punta-cana", "london", "cancun"]) {
      expect(findDestination(id)?.driveFromRegion).toBeUndefined();
    }
    expect(findDestination("asheville")?.driveFromRegion?.southeast_us).toBeLessThanOrEqual(5);
  });

  it("covers the destinations the group is likely to ask about", () => {
    const wanted = [
      "Asheville", "Charleston", "Savannah", "Outer Banks", "Myrtle Beach", "Gatlinburg", "Wilmington", "DC", "Nashville",
      "NYC", "Miami", "New Orleans", "Austin", "Chicago", "Denver", "Las Vegas", "San Diego", "LA", "San Francisco",
      "Seattle", "Portland", "Key West", "Orlando", "Boston", "Honolulu", "Atlanta", "Cancún", "Tulum", "San Juan",
      "Mexico City", "Puerto Vallarta", "Nassau", "Punta Cana", "Montreal", "Toronto", "Lisbon", "Barcelona", "London",
      "Reykjavik", "Costa Rica", "Medellín",
    ];
    for (const name of wanted) expect(findDestination(name), name).toBeDefined();
  });
});

describe("findDestination", () => {
  it.each([
    ["cancun", "cancun"],
    ["Cancún", "cancun"],
    ["CANCUN!", "cancun"],
    ["puerto rico", "san-juan"],
    ["San Juan, Puerto Rico", "san-juan"],
    ["the smokies", "gatlinburg"],
    ["Smoky Mountains", "gatlinburg"],
    ["obx", "outer-banks"],
    ["the outer banks", "outer-banks"],
    ["nyc", "new-york"],
    ["New York", "new-york"],
    ["vegas", "las-vegas"],
    ["washington-dc", "washington-dc"],
    ["costa rica", "guanacaste"],
    ["medellin", "medellin"],
    ["Tulum, Mexico", "tulum"],
  ])("%s → %s", (query, id) => {
    expect(findDestination(query)?.id).toBe(id);
  });

  it("does not guess", () => {
    expect(findDestination("atlantis")).toBeUndefined();
    expect(findDestination("city")).toBeUndefined();
    expect(findDestination("beach")).toBeUndefined();
    expect(findDestination("")).toBeUndefined();
  });
});

describe("airports.json", () => {
  const list = airports();

  it("has ~80+ home cities with valid codes and regions", () => {
    expect(list.length).toBeGreaterThanOrEqual(80);
    for (const a of list) {
      expect(a.iata).toMatch(/^[A-Z]{3}$/);
      expect(a.state).toMatch(/^[A-Z]{2}$/);
      expect(ORIGIN_REGIONS).toContain(a.region);
      expect(Math.abs(a.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(a.lon)).toBeLessThanOrEqual(180);
    }
    for (const region of ORIGIN_REGIONS) expect(list.some((a) => a.region === region), region).toBe(true);
  });

  it("aliases are unambiguous", () => {
    const owner = (a: { city: string; state: string }): string => `${a.city}, ${a.state}`;
    const byAlias = new Map<string, Set<string>>();
    for (const a of list) {
      for (const alias of a.aliases) {
        const key = alias.toLowerCase();
        byAlias.set(key, (byAlias.get(key) ?? new Set()).add(owner(a)));
      }
    }
    for (const [alias, owners] of byAlias) expect([...owners], alias).toHaveLength(1);
    const cityOwner = new Map(list.map((a) => [a.city.toLowerCase(), owner(a)]));
    for (const a of list) {
      for (const alias of a.aliases) {
        const city = cityOwner.get(alias.toLowerCase());
        if (city) expect(city, alias).toBe(owner(a));
      }
    }
  });
});

describe("resolveHome", () => {
  it.each([
    ["Chapel Hill", "RDU"],
    ["chapel hill, nc", "RDU"],
    ["Durham", "RDU"],
    ["Raleigh, NC", "RDU"],
    ["raleigh nc", "RDU"],
    ["Raleigh, North Carolina", "RDU"],
    ["UNC", "RDU"],
    ["duke", "RDU"],
    ["RDU", "RDU"],
    ["Charlotte", "CLT"],
    ["Greensboro", "GSO"],
    ["Wilmington", "ILM"],
    ["NYC", "JFK"],
    ["new york", "JFK"],
    ["Manhattan", "JFK"],
    ["brooklyn", "JFK"],
    ["Boston", "BOS"],
    ["harvard", "BOS"],
    ["Atlanta", "ATL"],
    ["Portland, OR", "PDX"],
    ["portland oregon", "PDX"],
    ["Washington, DC", "DCA"],
  ])("%s → %s", (city, iata) => {
    expect(resolveHome(city)?.iata).toBe(iata);
  });

  it("returns the region with the airport", () => {
    expect(resolveHome("Chapel Hill")?.region).toBe("southeast_us");
    expect(resolveHome("brooklyn")?.region).toBe("northeast_us");
    expect(resolveHome("Austin")?.region).toBe("south_central_us");
  });

  it("refuses wrong-state and unknown places", () => {
    expect(resolveHome("Wilmington, DE")).toBeUndefined();
    expect(resolveHome("Gotham")).toBeUndefined();
    expect(resolveHome("")).toBeUndefined();
  });
});

describe("normalizeTag", () => {
  it("maps everyday words onto catalog tags", () => {
    expect(normalizeTag("beaches")).toBe("beach");
    expect(normalizeTag("Skiing")).toBe("snow");
    expect(normalizeTag("party")).toBe("nightlife");
    expect(normalizeTag("budget friendly")).toBe("budget_friendly");
    expect(normalizeTag("museums")).toBe("culture");
    expect(normalizeTag("spelunking")).toBeUndefined();
  });
});
