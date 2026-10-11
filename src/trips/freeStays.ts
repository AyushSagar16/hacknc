// Keyless stay prices, used when SerpApi has no answer: hotels from Xotelo (TripAdvisor's partner
// rates for each hotel: Booking.com, Agoda, Trip.com...) and whole-place rentals from Airbnb's own
// search page, which carries its results as JSON. Neither needs an account. Both are unofficial,
// so every step is best-effort: a changed page or a refused request yields nothing, never a throw,
// and callers fall back to SerpApi's cache or catalog estimates. Answers share the price cache.
import type { Destination } from "./catalog.ts";
import { cachedGet, type PriceDeps } from "./pricing.ts";

export const XOTELO_API = "https://data.xotelo.com/api";
export const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
export const AIRBNB_SEARCH = "https://www.airbnb.com/s";
/** Hotels priced per destination: one /rates request each. */
export const XOTELO_HOTELS = 6;
/** Xotelo prices a room for this many adults. */
export const XOTELO_ADULTS = 2;
/** Half-width of the map box Airbnb searches around the destination (km). */
export const AIRBNB_BOX_KM = 12;
/** TripAdvisor ids rarely change; a place's id is looked up once a month. */
const GEO_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Airbnb serves its full search page to browsers; Wikidata asks for a descriptive agent.
const BROWSER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const WIKIDATA_AGENT = "AtlasTripPlanner/0.1 (group trip planner; prices lookup)";

export interface FreeHotel {
  name: string;
  /** One room for XOTELO_ADULTS, all nights, cheapest site (USD). */
  roomTotalUsd: number;
  site: string;
  rating: number | null;
  reviews: number | null;
  link: string;
  lat: number | null;
  lon: number | null;
}

export interface FreeRental {
  name: string;
  /** "Cabin in Weaverville". */
  kind: string;
  /** The whole place, all nights (USD). */
  totalUsd: number;
  rating: number | null;
  reviews: number | null;
  link: string;
  lat: number | null;
  lon: number | null;
}

const field = (obj: unknown, key: string): unknown => (obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined);
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const num = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

async function getJson(url: string, deps: PriceDeps, signal: AbortSignal, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await deps.fetch(url, { signal, headers });
  return res.ok ? ((await res.json()) as unknown) : undefined;
}

// ---------- hotels (Xotelo) ----------

/**
 * SPARQL for the most populous place within 25 km that has a TripAdvisor id (Wikidata P3134).
 * Only numeric ids are geos; hotels and attractions carry other forms. Countries are skipped.
 */
export function geoQuery(lat: number, lon: number): string {
  return `SELECT ?ta WHERE { SERVICE wikibase:around { ?item wdt:P625 ?loc . bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "25" . } ?item wdt:P3134 ?ta . ?item wdt:P1082 ?pop . FILTER(REGEX(?ta, "^[0-9]+$")) FILTER NOT EXISTS { ?item wdt:P31 wd:Q6256 } } ORDER BY DESC(?pop) LIMIT 1`;
}

/** The TripAdvisor geo ("g60742") for a place: from the catalog, else Wikidata by coordinates. */
export async function tripadvisorGeo(dest: Destination, deps: PriceDeps): Promise<string | undefined> {
  if (dest.tripadvisorGeo) return dest.tripadvisorGeo;
  const lat = dest.lat.toFixed(3);
  const lon = dest.lon.toFixed(3);
  const hit = await cachedGet(
    `tripadvisor-geo:${lat},${lon}`,
    async (signal) => {
      const body = await getJson(`${WIKIDATA_SPARQL}?query=${encodeURIComponent(geoQuery(dest.lat, dest.lon))}`, deps, signal, { accept: "application/sparql-results+json", "user-agent": WIKIDATA_AGENT });
      const value = field(field((field(field(body, "results"), "bindings") as unknown[] | undefined)?.[0], "ta"), "value");
      return typeof value === "string" && /^\d+$/.test(value) ? { geo: `g${value}` } : undefined;
    },
    deps,
    GEO_MAX_AGE_MS,
  );
  const geo = field(hit?.body, "geo");
  return typeof geo === "string" ? geo : undefined;
}

export function xoteloListUrl(geo: string): string {
  return `${XOTELO_API}/list?${new URLSearchParams({ location_key: geo, limit: "30", offset: "0", sort: "best_value" })}`;
}

export function xoteloRatesUrl(hotelKey: string, start: string, end: string): string {
  return `${XOTELO_API}/rates?${new URLSearchParams({ hotel_key: hotelKey, chk_in: start, chk_out: end, currency: "USD", rooms: "1", adults: String(XOTELO_ADULTS) })}`;
}

interface ListedHotel {
  key: string;
  name: string;
  rating: number | null;
  reviews: number | null;
  link: string;
  lat: number | null;
  lon: number | null;
}

/** Hotels from a Xotelo /list body, in its order (best value first). */
export function parseXoteloList(body: unknown): ListedHotel[] {
  if (field(body, "error")) return [];
  const list = field(field(body, "result"), "list");
  if (!Array.isArray(list)) return [];
  const out: ListedHotel[] = [];
  for (const h of list) {
    const key = field(h, "key");
    const name = field(h, "name");
    if (typeof key !== "string" || !/^g\d+-d\d+$/.test(key) || typeof name !== "string" || !name.trim()) continue;
    const url = field(h, "url");
    const review = field(h, "review_summary");
    const geo = field(h, "geo");
    out.push({
      key,
      name: name.trim(),
      rating: positive(field(review, "rating")) ? (field(review, "rating") as number) : null,
      reviews: positive(field(review, "count")) ? (field(review, "count") as number) : null,
      link: typeof url === "string" && /^https:\/\//.test(url) ? url : `https://www.tripadvisor.com/Hotel_Review-${key}`,
      lat: num(field(geo, "latitude")),
      lon: num(field(geo, "longitude")),
    });
  }
  return out;
}

/** The cheapest site's nightly room rate (USD) from a Xotelo /rates body. */
export function cheapestXoteloRate(body: unknown): { rate: number; site: string } | undefined {
  if (field(body, "error")) return undefined;
  const rates = field(field(body, "result"), "rates");
  if (!Array.isArray(rates)) return undefined;
  let best: { rate: number; site: string } | undefined;
  for (const r of rates) {
    const rate = field(r, "rate");
    const tax = field(r, "tax");
    if (!positive(rate)) continue;
    const total = rate + (positive(tax) ? tax : 0);
    if (!best || total < best.rate) best = { rate: total, site: String(field(r, "name") ?? field(r, "code") ?? "") };
  }
  return best;
}

/**
 * Up to XOTELO_HOTELS hotels at the destination with a room priced for these dates. Undefined
 * when the place has no TripAdvisor id or nothing came back.
 */
export async function xoteloHotels(dest: Destination, dates: { start: string; end: string }, nights: number, deps: PriceDeps): Promise<{ hotels: FreeHotel[]; fetchedAt: Date } | undefined> {
  try {
    const geo = await tripadvisorGeo(dest, deps);
    if (!geo) return undefined;
    const list = await cachedGet(`xotelo:list:${geo}`, (signal) => getJson(xoteloListUrl(geo), deps, signal).then((b) => (parseXoteloList(b).length ? b : undefined)), deps);
    const listed = list ? parseXoteloList(list.body).slice(0, XOTELO_HOTELS) : [];
    if (listed.length === 0) return undefined;
    const rated = await Promise.all(
      listed.map((h) =>
        cachedGet(`xotelo:rates:${h.key}:${dates.start}:${dates.end}:${XOTELO_ADULTS}`, (signal) => getJson(xoteloRatesUrl(h.key, dates.start, dates.end), deps, signal).then((b) => (cheapestXoteloRate(b) ? b : undefined)), deps),
      ),
    );
    const hotels: FreeHotel[] = [];
    let fetchedAt: Date | undefined;
    listed.forEach((h, i) => {
      const result = rated[i];
      const best = result ? cheapestXoteloRate(result.body) : undefined;
      if (!best) return;
      if (!fetchedAt || result!.fetchedAt < fetchedAt) fetchedAt = result!.fetchedAt;
      hotels.push({ name: h.name, roomTotalUsd: best.rate * Math.max(1, nights), site: best.site, rating: h.rating, reviews: h.reviews, link: h.link, lat: h.lat, lon: h.lon });
    });
    return hotels.length && fetchedAt ? { hotels, fetchedAt } : undefined;
  } catch {
    return undefined;
  }
}

// ---------- rentals (Airbnb) ----------

/** "Asheville, NC" / "Lisbon, Portugal": what Airbnb's search box understands. */
export function airbnbPlace(dest: Destination): string {
  return [dest.name, dest.state ?? dest.country].filter(Boolean).join(", ");
}

/**
 * Airbnb's search page. With `around`, results are held to a map box AIRBNB_BOX_KM each way of
 * that point; a place name alone can reach towns half an hour out ("Lisbon" → Cascais).
 */
export function airbnbSearchUrl(place: string, start: string, end: string, adults: number, around?: { lat: number; lon: number }): string {
  const qs = new URLSearchParams({ checkin: start, checkout: end, adults: String(Math.max(1, adults)), currency: "USD", locale: "en" });
  if (around) {
    const dLat = AIRBNB_BOX_KM / 111;
    const dLon = AIRBNB_BOX_KM / (111 * Math.max(0.2, Math.cos((around.lat * Math.PI) / 180)));
    const f = (n: number) => n.toFixed(4);
    qs.set("ne_lat", f(around.lat + dLat));
    qs.set("ne_lng", f(around.lon + dLon));
    qs.set("sw_lat", f(around.lat - dLat));
    qs.set("sw_lng", f(around.lon - dLon));
    qs.set("search_by_map", "true");
  }
  return `${AIRBNB_SEARCH}/${encodeURIComponent(place)}/homes?${qs}`;
}

/** "$1,234 for 2 nights, originally $1,400" → 1234 for the stay; "$120 per night" → 120 × nights. */
export function airbnbStayUsd(label: string, nights: number): number | undefined {
  const m = /\$\s?([\d,]+(?:\.\d+)?)/.exec(label);
  if (!m) return undefined;
  const amount = Number(m[1]!.replace(/,/g, ""));
  if (!positive(amount)) return undefined;
  const perNight = /\b(per\s+night|\/\s*night|a\s+night|night)\b/i.test(label) && !/\bfor\s+\d+\s+nights?\b/i.test(label);
  return perNight ? amount * Math.max(1, nights) : amount;
}

/** The listing number inside Airbnb's base64 ids ("DemandStayListing:123…"). */
function listingNumber(id: unknown): string | undefined {
  if (typeof id !== "string") return undefined;
  if (/^\d+$/.test(id)) return id;
  try {
    const decoded = Buffer.from(id, "base64").toString("utf8");
    return /:(\d+)$/.exec(decoded)?.[1];
  } catch {
    return undefined;
  }
}

function findKey(obj: unknown, key: string, depth = 0): unknown {
  if (!obj || typeof obj !== "object" || depth > 12) return undefined;
  if (key in obj) return (obj as Record<string, unknown>)[key];
  for (const v of Object.values(obj)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Rentals from an Airbnb search page. The results live as JSON in a deferred-state script tag
 * (staysSearch → searchResults). Private and shared rooms are dropped: a group needs the place.
 */
export function parseAirbnbPage(html: string, opts: { nights: number; start: string; end: string; adults: number }): FreeRental[] {
  const out: FreeRental[] = [];
  for (const m of html.matchAll(/<script[^>]*id="data-deferred-state-\d+"[^>]*>([\s\S]*?)<\/script>/g)) {
    let state: unknown;
    try {
      state = JSON.parse(m[1]!);
    } catch {
      continue;
    }
    const results = findKey(findKey(state, "staysSearch"), "searchResults");
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      const listing = field(r, "demandStayListing") ?? field(r, "listing");
      const kind = String(field(r, "title") ?? "").trim();
      if (/^(private |shared )?room in\b/i.test(kind)) continue;
      const named = field(field(r, "nameLocalized"), "localizedStringWithTranslationPreference") ?? field(field(field(listing, "description"), "name"), "localizedStringWithTranslationPreference") ?? field(listing, "name");
      const name = typeof named === "string" && named.trim() ? named.replace(/\s+/g, " ").trim() : kind;
      const id = listingNumber(field(listing, "id") ?? field(r, "listingId"));
      const primary = field(field(r, "structuredDisplayPrice"), "primaryLine");
      const label = [field(primary, "accessibilityLabel"), [field(primary, "price"), field(primary, "qualifier")].filter(Boolean).join(" ")].find((l): l is string => typeof l === "string" && l.includes("$"));
      const totalUsd = label ? airbnbStayUsd(label, opts.nights) : undefined;
      if (!name || !id || totalUsd === undefined) continue;
      const ratingText = String(field(r, "avgRatingLocalized") ?? "");
      const rm = /^(\d(?:\.\d+)?)\s*\((\d[\d,]*)\)/.exec(ratingText);
      const coord = field(field(listing, "location"), "coordinate") ?? field(listing, "coordinate");
      const qs = new URLSearchParams({ check_in: opts.start, check_out: opts.end, adults: String(Math.max(1, opts.adults)) });
      out.push({
        name,
        kind: kind || "Rental",
        totalUsd,
        rating: rm ? Number(rm[1]) : null,
        reviews: rm ? Number(rm[2]!.replace(/,/g, "")) : null,
        link: `https://www.airbnb.com/rooms/${id}?${qs}`,
        lat: num(field(coord, "latitude")),
        lon: num(field(coord, "longitude")),
      });
    }
    if (out.length) break;
  }
  return out;
}

/**
 * Airbnb places at the destination for these dates that take the whole group (Airbnb's own guest
 * filter), whole-stay prices in USD. Only the parsed listings are cached, never the page.
 */
export async function airbnbRentals(dest: Destination, dates: { start: string; end: string }, nights: number, adults: number, deps: PriceDeps): Promise<{ rentals: FreeRental[]; fetchedAt: Date } | undefined> {
  const place = airbnbPlace(dest);
  const n = Math.max(1, adults);
  const hit = await cachedGet(
    `airbnb:${place.toLowerCase()}:${dates.start}:${dates.end}:${n}`,
    async (signal) => {
      // Near the destination first; the whole named area if that box is empty.
      for (const around of [{ lat: dest.lat, lon: dest.lon }, undefined]) {
        const res = await deps.fetch(airbnbSearchUrl(place, dates.start, dates.end, n, around), { signal, headers: { "user-agent": BROWSER_AGENT, "accept-language": "en-US,en;q=0.9", accept: "text/html" } });
        if (!res.ok) return undefined;
        const rentals = parseAirbnbPage(await res.text(), { nights, start: dates.start, end: dates.end, adults: n });
        if (rentals.length) return rentals;
      }
      return undefined;
    },
    deps,
  );
  return hit && Array.isArray(hit.body) && hit.body.length ? { rentals: hit.body as FreeRental[], fetchedAt: hit.fetchedAt } : undefined;
}
