// Places that aren't in the destination catalog ("outer banks", "lake lure, nc"), resolved to
// coordinates with Open-Meteo's keyless geocoding API. One request per new name: answers (and
// misses) are cached in memory and, when a cache is given, in Postgres. Network only through the
// injected fetch, with a timeout; tests and the simulator stub answers and never touch the network.
import { z } from "zod";
import { normalizeName } from "./catalog.ts";
import { requestJson, WeatherError } from "../weather/openMeteo.ts";

export const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
export const GEOCODE_TIMEOUT_MS = 5_000;
/** How long a cached answer is trusted. Places don't move; misses are retried sooner. */
export const GEOCODE_TTL_MS = 30 * 24 * 3_600_000;
export const GEOCODE_MISS_TTL_MS = 6 * 3_600_000;

export interface Place {
  name: string;
  /** State or province ("North Carolina"). */
  admin1?: string;
  country?: string;
  countryCode?: string;
  lat: number;
  lon: number;
  timezone?: string;
  population?: number;
}

export interface GeocodeCache {
  get(key: string): Promise<{ body: unknown; fetchedAt: Date } | undefined>;
  set(key: string, body: unknown, at: Date): Promise<void>;
}

export interface GeocodeDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
  cache?: GeocodeCache;
  now?: () => Date;
}

/** The geocoder couldn't be reached (as opposed to "no such place", which is null). */
export class GeocodeUnavailable extends Error {}

const Body = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        timezone: z.string().optional(),
        country: z.string().optional(),
        country_code: z.string().optional(),
        admin1: z.string().optional(),
        population: z.number().optional(),
      }),
    )
    .optional(),
});

let defaultFetch: typeof fetch | undefined;
/** Tests and the simulator inject a fake; undefined restores the real fetch. */
export function setGeocodeFetch(f: typeof fetch | undefined): void {
  defaultFetch = f;
}

const memory = new Map<string, { place: Place | null; at: number }>();
const stubs = new Map<string, Place | null>();

/** Answer a name without the network (simulator scenarios, tests). */
export function stubGeocode(query: string, place: Place | null): void {
  stubs.set(cacheKeyFor(query), place);
}

export function clearGeocodeCache(): void {
  memory.clear();
  stubs.clear();
}

export function cacheKeyFor(query: string): string {
  return `geocode:${normalizeName(query)}`;
}

const STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut",
  de: "delaware", dc: "district of columbia", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois",
  in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland",
  ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana",
  ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york",
  nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania",
  ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah",
  vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
};

/** "lake lure, nc" → { name: "lake lure", qualifier: "north carolina" }. */
export function splitQuery(query: string): { name: string; qualifier?: string } {
  const comma = query.indexOf(",");
  if (comma < 0) return { name: query.trim() };
  const name = query.slice(0, comma).trim();
  const tail = normalizeName(query.slice(comma + 1));
  if (!tail) return { name };
  return { name, qualifier: STATES[tail] ?? tail };
}

/** The best result for a query: the first whose state/country matches the qualifier, else the first. */
export function pickResult(body: unknown, qualifier?: string): Place | null {
  const parsed = Body.safeParse(body);
  if (!parsed.success) throw new GeocodeUnavailable(`unexpected geocoding shape: ${parsed.error.message}`);
  const results = parsed.data.results ?? [];
  const matches = (r: (typeof results)[number]) => {
    if (!qualifier) return true;
    const q = normalizeName(qualifier);
    return [r.admin1, r.country, r.country_code].some((x) => x && normalizeName(x) === q);
  };
  const top = results.find(matches) ?? (qualifier ? undefined : results[0]);
  if (!top) return null;
  return {
    name: top.name,
    ...(top.admin1 ? { admin1: top.admin1 } : {}),
    ...(top.country ? { country: top.country } : {}),
    ...(top.country_code ? { countryCode: top.country_code.toUpperCase() } : {}),
    lat: top.latitude,
    lon: top.longitude,
    ...(top.timezone ? { timezone: top.timezone } : {}),
    ...(top.population ? { population: top.population } : {}),
  };
}

/**
 * Resolve a free-form place name to coordinates. Null when nothing matches; throws
 * GeocodeUnavailable when the API can't be reached (and nothing is cached).
 */
export async function geocodePlace(query: string, deps: GeocodeDeps = {}): Promise<Place | null> {
  const raw = query.trim();
  if (!raw) return null;
  const key = cacheKeyFor(raw);
  if (stubs.has(key)) return stubs.get(key)!;
  const at = (deps.now ?? (() => new Date()))();
  const ttl = (p: Place | null) => (p ? GEOCODE_TTL_MS : GEOCODE_MISS_TTL_MS);
  const hit = memory.get(key);
  if (hit && at.getTime() - hit.at <= ttl(hit.place)) return hit.place;
  if (deps.cache) {
    try {
      const row = await deps.cache.get(key);
      const place = (row?.body as { place?: Place | null } | undefined)?.place;
      if (row && place !== undefined && at.getTime() - new Date(row.fetchedAt).getTime() <= ttl(place)) {
        memory.set(key, { place, at: new Date(row.fetchedAt).getTime() });
        return place;
      }
    } catch {
      // A broken cache is a miss.
    }
  }

  const { name, qualifier } = splitQuery(raw);
  if (!name) return null;
  const params = new URLSearchParams({ name, count: qualifier ? "10" : "5", language: "en", format: "json" });
  const fetchImpl = deps.fetch ?? defaultFetch ?? fetch;
  let body: unknown;
  try {
    body = await requestJson(`${GEOCODE_URL}?${params}`, { fetch: fetchImpl, timeoutMs: deps.timeoutMs ?? GEOCODE_TIMEOUT_MS, retryDelayMs: 200 });
  } catch (err) {
    throw new GeocodeUnavailable(err instanceof WeatherError ? err.message : String(err));
  }
  const place = pickResult(body, qualifier);
  memory.set(key, { place, at: at.getTime() });
  if (deps.cache) await deps.cache.set(key, { place }, at).catch(() => {});
  return place;
}

/** "Lake Lure, North Carolina" / "Lisbon, Portugal" for messages. */
export function placeLabel(p: Pick<Place, "name" | "admin1" | "country" | "countryCode">): string {
  if (p.countryCode === "US" || p.country === "United States") return p.admin1 ? `${p.name}, ${p.admin1}` : p.name;
  return p.country ? `${p.name}, ${p.country}` : p.name;
}
