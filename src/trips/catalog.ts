// Typed access to the destination and home-airport catalogs in data/, plus the fuzzy-but-
// deterministic name matching ("cancun", "the smokies", "raleigh, nc") everything else relies on.
import destinationData from "../../data/destinations.json" with { type: "json" };
import airportData from "../../data/airports.json" with { type: "json" };

export const ORIGIN_REGIONS = ["southeast_us", "northeast_us", "midwest_us", "south_central_us", "mountain_us", "west_us"] as const;
export type OriginRegion = (typeof ORIGIN_REGIONS)[number];

export const REGIONS = [...ORIGIN_REGIONS, "hawaii", "caribbean", "mexico", "canada", "europe", "central_america", "south_america"] as const;
export type Region = (typeof REGIONS)[number];

export const TAGS = [
  "beach", "food", "nightlife", "culture", "outdoors", "hiking", "mountains", "city", "music", "relaxing",
  "adventure", "shopping", "history", "snow", "walkable", "budget_friendly", "luxury",
] as const;
export type Tag = (typeof TAGS)[number];

export const DIETARY_NEEDS = ["vegetarian", "vegan", "halal", "kosher", "gluten_free"] as const;
export type DietaryNeed = (typeof DIETARY_NEEDS)[number];

export type Tier = "budget" | "mid";
export type Setting = "outdoor" | "indoor" | "either";
export type Mobility = "easy" | "moderate" | "strenuous";

export interface Activity {
  id: string;
  name: string;
  tags: Tag[];
  setting: Setting;
  costCents: number;
  durationHours: number;
  mobility: Mobility;
}

export interface FlightBand {
  /** Per-person round trip, [low, high]. */
  roundTripCents: [number, number];
  /** Typical door-to-gate-to-gate one-way hours, connections included. */
  hours: number;
}

export interface Destination {
  id: string;
  name: string;
  state?: string;
  country: string;
  region: Region;
  iata: string;
  lat: number;
  lon: number;
  timezone: string;
  passportRequired: boolean;
  aliases: string[];
  tags: Tag[];
  dietary: Record<DietaryNeed, number>;
  bestMonths: number[];
  badMonths: number[];
  /** Why each bad month is bad, keyed by month number ("9": "hurricane season"). */
  badMonthReasons?: Record<string, string>;
  costs: {
    lodgingPerNightCents: Record<Tier, number>;
    foodPerDayCents: Record<Tier, number>;
    activitiesPerDayCents: Record<Tier, number>;
    localTransportPerDayCents: number;
  };
  flightFromRegion: Partial<Record<OriginRegion, FlightBand>>;
  /** One-way driving hours, only where 10 h or less. */
  driveFromRegion?: Partial<Record<OriginRegion, number>>;
  activities: Activity[];
}

export interface Airport {
  city: string;
  state: string;
  iata: string;
  region: OriginRegion;
  lat: number;
  lon: number;
  aliases: string[];
}

const DESTINATIONS = destinationData as unknown as Destination[];
const AIRPORTS = airportData as unknown as Airport[];

export function destinations(): Destination[] {
  return DESTINATIONS;
}

export function airports(): Airport[] {
  return AIRPORTS;
}

/** Lowercase, strip accents and punctuation, collapse whitespace: "Cancún!" → "cancun". */
export function normalizeName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutArticle(key: string): string {
  return key.startsWith("the ") ? key.slice(4) : key;
}

const destinationIndex = new Map<string, Destination>();
for (const d of DESTINATIONS) {
  const keys = [d.id, d.name, ...d.aliases];
  if (d.state) keys.push(`${d.name} ${d.state}`);
  keys.push(`${d.name} ${d.country}`);
  for (const key of keys) {
    const k = normalizeName(key);
    if (k && !destinationIndex.has(k)) destinationIndex.set(k, d);
  }
}

/** Every normalized key (id, name, alias) a destination answers to. */
export function destinationKeys(d: Destination): string[] {
  return [...new Set([d.id.replace(/-/g, " "), d.name, ...d.aliases].map(normalizeName).filter(Boolean))];
}

/** Case- and accent-insensitive lookup by id, name, alias, or "Name, Country". */
export function findDestination(nameOrId: string): Destination | undefined {
  const key = normalizeName(nameOrId);
  if (!key) return undefined;
  const candidates = [key, withoutArticle(key)];
  const comma = nameOrId.indexOf(",");
  if (comma > 0) candidates.push(normalizeName(nameOrId.slice(0, comma)));
  for (const c of candidates) {
    const hit = destinationIndex.get(c);
    if (hit) return hit;
  }
  return undefined;
}

export function destinationById(id: string): Destination | undefined {
  return DESTINATIONS.find((d) => d.id === id);
}

export function airportByIata(iata: string): Airport | undefined {
  const code = iata.trim().toUpperCase();
  return AIRPORTS.find((a) => a.iata === code);
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
const STATE_BY_NAME = new Map(Object.entries(STATES).map(([abbr, name]) => [name, abbr]));

function stateCode(text: string): string | undefined {
  const t = normalizeName(text);
  if (STATES[t]) return t;
  return STATE_BY_NAME.get(t);
}

function airportsMatching(place: string): Airport[] {
  return AIRPORTS.filter((a) => normalizeName(a.city) === place || a.aliases.some((alias) => normalizeName(alias) === place));
}

/** Resolve where someone lives ("Chapel Hill", "raleigh, nc", "UNC", "RDU") to a home airport. */
export function resolveHome(city: string): Airport | undefined {
  const raw = city.trim();
  if (!raw) return undefined;
  const whole = normalizeName(raw);
  if (!whole) return undefined;

  let place = whole;
  let state: string | undefined;
  const comma = raw.indexOf(",");
  if (comma > 0) {
    place = normalizeName(raw.slice(0, comma));
    state = stateCode(raw.slice(comma + 1));
  } else {
    const words = whole.split(" ");
    // "raleigh nc", "portland oregon", "new york new york" — peel a trailing state off.
    for (const n of [2, 1]) {
      if (words.length <= n) continue;
      const tail = stateCode(words.slice(-n).join(" "));
      if (tail) {
        place = words.slice(0, -n).join(" ");
        state = tail;
        break;
      }
    }
  }

  for (const candidate of [whole, place, withoutArticle(place)]) {
    const hits = airportsMatching(candidate);
    if (hits.length === 0) continue;
    // "Wilmington, DE" must not silently become Wilmington, NC.
    if (state) return hits.find((a) => a.state.toLowerCase() === state);
    return hits[0];
  }
  if (/^[a-z]{3}$/.test(whole)) return airportByIata(whole);
  return undefined;
}

/** Map free text ("beaches", "skiing", "party") onto a catalog tag. */
export function normalizeTag(text: string): Tag | undefined {
  const t = normalizeName(text).replace(/ /g, "_");
  if ((TAGS as readonly string[]).includes(t)) return t as Tag;
  return TAG_SYNONYMS[t.replace(/_/g, " ")];
}

const TAG_SYNONYMS: Record<string, Tag> = {
  beaches: "beach", ocean: "beach", coast: "beach", island: "beach", islands: "beach", surf: "beach", surfing: "beach", sand: "beach",
  foodie: "food", eating: "food", restaurants: "food", cuisine: "food", eats: "food",
  party: "nightlife", partying: "nightlife", clubs: "nightlife", clubbing: "nightlife", bars: "nightlife", "going out": "nightlife",
  museums: "culture", museum: "culture", art: "culture", arts: "culture",
  outdoor: "outdoors", nature: "outdoors",
  hike: "hiking", hikes: "hiking", trails: "hiking",
  mountain: "mountains",
  cities: "city", urban: "city",
  concerts: "music", "live music": "music", jazz: "music",
  relax: "relaxing", chill: "relaxing", "laid back": "relaxing", "low key": "relaxing", spa: "relaxing",
  adventurous: "adventure", thrill: "adventure", thrills: "adventure",
  shops: "shopping",
  historic: "history", historical: "history",
  skiing: "snow", ski: "snow", snowboarding: "snow",
  walking: "walkable",
  budget: "budget_friendly", cheap: "budget_friendly", affordable: "budget_friendly",
  fancy: "luxury", bougie: "luxury", upscale: "luxury",
};
