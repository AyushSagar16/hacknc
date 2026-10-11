// Live price layer over SerpApi (google_flights, google_hotels) with a cache and a per-component
// fallback to catalog estimates. Every dependency is injected; pricing failures never throw.
import { airportByIata, resolveHome, type Destination, type Tier } from "./catalog.ts";
import { daysBetween } from "../clock.ts";
import { estimateCost, withTotal, type CostBreakdown } from "./estimate.ts";
import type { MemberConstraints } from "./filter.ts";

export interface PriceCache {
  get(key: string): Promise<{ body: unknown; fetchedAt: Date } | undefined>;
  set(key: string, body: unknown, at: Date): Promise<void>;
}

export interface PriceDeps {
  apiKey?: string;
  fetch: typeof fetch;
  cache: PriceCache;
  now: () => Date;
  /** How old a cached response may be. Default 12 h. */
  maxAgeMs?: number;
  /** Per-request timeout. Default 8 s. */
  timeoutMs?: number;
}

export const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
export const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 8000;
/** google_hotels prices a room for this many adults; per-person lodging = room total ÷ this. */
export const ADULTS_PER_ROOM = 2;
const CHEAPEST_HOTELS = 5;

type Params = Record<string, string>;

/** Cache key for a search. Never includes the API key. */
export function cacheKey(params: Params): string {
  const parts = Object.keys(params)
    .filter((k) => k !== "api_key")
    .sort()
    .map((k) => `${k}=${params[k]}`);
  return `serpapi:${parts.join("&")}`;
}

export function serpApiUrl(params: Params, apiKey: string): string {
  const qs = new URLSearchParams({ ...params, api_key: apiKey });
  return `${SERPAPI_ENDPOINT}?${qs.toString()}`;
}

export function flightSearchParams(origin: string, dest: string, start: string, end: string, adults: number): Params {
  return {
    engine: "google_flights",
    departure_id: origin,
    arrival_id: dest,
    outbound_date: start,
    return_date: end,
    type: "1", // round trip
    adults: String(adults),
    currency: "USD",
    hl: "en",
    gl: "us",
    sort_by: "2", // price
  };
}

export function hotelSearchParams(destName: string, start: string, end: string): Params {
  return {
    engine: "google_hotels",
    q: `${destName} hotels`,
    check_in_date: start,
    check_out_date: end,
    adults: String(ADULTS_PER_ROOM),
    currency: "USD",
    hl: "en",
    gl: "us",
  };
}

interface Fetched {
  body: unknown;
  fetchedAt: Date;
}

async function search(params: Params, deps: PriceDeps): Promise<Fetched | undefined> {
  const key = cacheKey(params);
  const maxAge = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  try {
    const hit = await deps.cache.get(key);
    if (hit && deps.now().getTime() - new Date(hit.fetchedAt).getTime() <= maxAge) {
      return { body: hit.body, fetchedAt: new Date(hit.fetchedAt) };
    }
  } catch {
    // A broken cache is a miss.
  }
  if (!deps.apiKey) return undefined;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("serpapi timeout"));
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
  timeout.catch(() => undefined);
  try {
    const res = await Promise.race([deps.fetch(serpApiUrl(params, deps.apiKey), { signal: controller.signal }), timeout]);
    if (!res.ok) return undefined;
    const body: unknown = await Promise.race([res.json(), timeout]);
    if (!body || typeof body !== "object" || "error" in body) return undefined;
    const fetchedAt = deps.now();
    try {
      await deps.cache.set(key, body, fetchedAt);
    } catch {
      // Caching is best-effort.
    }
    return { body, fetchedAt };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Cheapest itinerary `price` (USD) across best_flights and other_flights. */
export function cheapestFlightUsd(body: unknown): number | undefined {
  const prices: number[] = [];
  for (const list of [field(body, "best_flights"), field(body, "other_flights")]) {
    if (!Array.isArray(list)) continue;
    for (const option of list) {
      const price = field(option, "price");
      if (positive(price)) prices.push(price);
    }
  }
  if (prices.length === 0) {
    const lowest = field(field(body, "price_insights"), "lowest_price");
    return positive(lowest) ? lowest : undefined;
  }
  return Math.min(...prices);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Per-person lodging (USD, whole stay) from a google_hotels response: each property's
 * total_rate.extracted_lowest is a room for ADULTS_PER_ROOM adults for all nights. Budget takes
 * the median of the five cheapest; mid takes the median of everything priced.
 */
export function lodgingPerPersonUsd(body: unknown, tier: Tier, nights: number): number | undefined {
  const properties = field(body, "properties");
  if (!Array.isArray(properties)) return undefined;
  const totals: number[] = [];
  for (const p of properties) {
    const total = field(field(p, "total_rate"), "extracted_lowest");
    const nightly = field(field(p, "rate_per_night"), "extracted_lowest");
    if (positive(total)) totals.push(total);
    else if (positive(nightly) && nights > 0) totals.push(nightly * nights);
  }
  if (totals.length === 0) return undefined;
  totals.sort((a, b) => a - b);
  const pool = tier === "budget" ? totals.slice(0, CHEAPEST_HOTELS) : totals;
  return median(pool) / ADULTS_PER_ROOM;
}

/** The IATA code someone flies from, if we know it. */
export function originIata(member: { homeAirport?: string }): string | undefined {
  const home = member.homeAirport?.trim();
  if (!home) return undefined;
  const known = airportByIata(home) ?? resolveHome(home);
  if (known) return known.iata;
  return /^[A-Za-z]{3}$/.test(home) ? home.toUpperCase() : undefined;
}

function estimatesFor(dest: Destination, members: MemberConstraints[], nights: number, tier: Tier): Map<number, CostBreakdown> {
  const groupSize = Math.max(1, members.length);
  return new Map(members.map((m) => [m.personId, estimateCost(dest, m, nights, tier, groupSize)]));
}

export async function priceOption(
  dest: Destination,
  members: MemberConstraints[],
  dates: { start: string; end: string },
  tier: Tier,
  deps: PriceDeps,
): Promise<Map<number, CostBreakdown>> {
  const nights = Math.max(1, daysBetween(dates.start, dates.end));
  const estimates = estimatesFor(dest, members, nights, tier);
  try {
    // Flyers grouped by origin airport: one search per origin. Drivers never trigger a search.
    const flyersByOrigin = new Map<string, number[]>();
    for (const m of members) {
      if (m.noFlying || estimates.get(m.personId)?.transportMode !== "flight") continue;
      const origin = originIata(m);
      // An off-catalog place with no airport nearby has no arrival code: flights stay estimates.
      if (!origin || !dest.iata || origin === dest.iata) continue;
      flyersByOrigin.set(origin, [...(flyersByOrigin.get(origin) ?? []), m.personId]);
    }

    const origins = [...flyersByOrigin.keys()].sort();
    const [hotel, ...flights] = await Promise.all([
      search(hotelSearchParams(dest.name, dates.start, dates.end), deps),
      ...origins.map((o) => search(flightSearchParams(o, dest.iata, dates.start, dates.end, flyersByOrigin.get(o)!.length), deps)),
    ]);

    // SerpApi mirrors Google Flights, whose `price` for a multi-adult search is (we believe) the
    // total for all passengers, so we divide by adults. If it turns out to be per person, live
    // fares will read low for groups — compare against the band in the estimate detail.
    const farePerPerson = new Map<number, { cents: number; checkedAt: string }>();
    origins.forEach((origin, i) => {
      const result = flights[i];
      const ids = flyersByOrigin.get(origin)!;
      const total = result ? cheapestFlightUsd(result.body) : undefined;
      if (total === undefined) return;
      const cents = Math.round((total * 100) / ids.length);
      for (const id of ids) farePerPerson.set(id, { cents, checkedAt: result!.fetchedAt.toISOString() });
    });

    const lodgingUsd = hotel ? lodgingPerPersonUsd(hotel.body, tier, nights) : undefined;
    const lodging = lodgingUsd === undefined ? undefined : { cents: Math.round(lodgingUsd * 100), checkedAt: hotel!.fetchedAt.toISOString() };

    const out = new Map<number, CostBreakdown>();
    for (const m of members) {
      const base = estimates.get(m.personId)!;
      const next = { ...base, sources: { ...base.sources } };
      const fare = farePerPerson.get(m.personId);
      if (fare) {
        next.transportCents = fare.cents;
        next.sources.transport = { kind: "live", detail: "google flights via serpapi", checkedAt: fare.checkedAt };
      }
      if (lodging) {
        next.lodgingCents = lodging.cents;
        next.sources.lodging = { kind: "live", detail: "google hotels via serpapi", checkedAt: lodging.checkedAt };
      }
      out.set(m.personId, withTotal(next));
    }
    return out;
  } catch {
    return estimates;
  }
}

/**
 * Live round-trip fares per flyer (cents), one search per origin airport, for an arrival airport.
 * People with no live answer are left out (callers keep their estimate). Never throws.
 */
export async function liveFlightFares(
  destIata: string,
  flyers: { personId: number; originIata: string }[],
  dates: { start: string; end: string },
  deps: PriceDeps,
): Promise<Map<number, { cents: number; checkedAt: string }>> {
  const out = new Map<number, { cents: number; checkedAt: string }>();
  if (!destIata) return out;
  try {
    const byOrigin = new Map<string, number[]>();
    for (const f of flyers) if (f.originIata && f.originIata !== destIata) byOrigin.set(f.originIata, [...(byOrigin.get(f.originIata) ?? []), f.personId]);
    const origins = [...byOrigin.keys()].sort();
    const results = await Promise.all(origins.map((o) => search(flightSearchParams(o, destIata, dates.start, dates.end, byOrigin.get(o)!.length), deps)));
    origins.forEach((origin, i) => {
      const result = results[i];
      const ids = byOrigin.get(origin)!;
      const total = result ? cheapestFlightUsd(result.body) : undefined;
      if (total === undefined) return;
      const cents = Math.round((total * 100) / ids.length);
      for (const id of ids) out.set(id, { cents, checkedAt: result!.fetchedAt.toISOString() });
    });
  } catch {
    // Live fares are best-effort; estimates stand.
  }
  return out;
}
