// Food and things to do around where the group is staying: SerpApi's google_maps engine searched
// around the stay (or the destination's centre when nothing is booked yet), parsed, filtered by
// the group's dietary needs and activity likes/dislikes, ranked, and cut to a short list.
// Price levels are kept as a 1–4 number and shown in words ("mid-range"), never as "$$", so the
// money guard and the page's no-prices rule never see them as a dollar figure.
// Offline (no key, or SerpApi down): the destination's catalog activities stand in, and the
// simulator can stub a response per kind from test/fixtures/serpapi. Never throws.
import { haversineMiles } from "./estimate.ts";
import { cacheKey, serpApiUrl, DEFAULT_TIMEOUT_MS, type PriceDeps } from "./pricing.ts";
import type { Destination } from "./catalog.ts";

export type NearbyKind = "food" | "activity";

export interface NearbyPlace {
  kind: NearbyKind;
  /** SerpApi place_id / data_id, "catalog:<activity id>" or "web:<name>". */
  sourceId: string;
  source: "serpapi" | "catalog" | "web" | "osm";
  name: string;
  /** "Vegetarian restaurant", "Museum". */
  category?: string;
  types: string[];
  address?: string;
  lat?: number;
  lon?: number;
  rating?: number;
  reviews?: number;
  /** 1 (cheap) … 4 (splurge). */
  priceLevel?: number;
  description?: string;
  /** Straight-line metres from the stay. */
  distanceM?: number;
  /** For catalog activities: indoor/outdoor and tags. */
  setting?: "outdoor" | "indoor" | "either";
  tags?: string[];
}

export interface Origin {
  lat: number;
  lon: number;
  /** "the airbnb", "Aloft Asheville Downtown", "downtown asheville". */
  label: string;
}

/** Cached map results stay good for a week; restaurants don't move much. */
export const NEARBY_MAX_AGE_MS = 7 * 24 * 3_600_000;
export const SHORTLIST_SIZE = 5;
const MIN_RATING = 3.8;

// ---------- search parameters ----------

export function mapsSearchParams(q: string, at: { lat: number; lon: number }): Record<string, string> {
  return { engine: "google_maps", type: "search", q, ll: `@${at.lat.toFixed(4)},${at.lon.toFixed(4)},14z`, hl: "en", gl: "us" };
}

/** Dietary needs, strictest first: the query asks for the strictest one anybody has. */
const DIET_QUERY: [need: string, phrase: string][] = [
  ["vegan", "vegan friendly restaurants"],
  ["vegetarian", "vegetarian friendly restaurants"],
  ["halal", "halal restaurants"],
  ["kosher", "kosher restaurants"],
  ["gluten_free", "gluten free friendly restaurants"],
];

export function foodQuery(dietary: Iterable<string>, extra?: string): string {
  if (extra?.trim()) return `${extra.trim()} restaurants`.replace(/\brestaurants restaurants$/i, "restaurants");
  const needs = new Set(dietary);
  return DIET_QUERY.find(([n]) => needs.has(n))?.[1] ?? "restaurants";
}

export function activityQuery(extra?: string): string {
  return extra?.trim() ? extra.trim() : "things to do";
}

/** Searches per kind beyond the general one, so the group's own tastes find better places. */
export const MAX_EXTRA_QUERIES = 2;

/** What to search for an interest the group has ("hiking" → "hiking trails"). */
const INTEREST_QUERY: Record<string, string> = {
  hiking: "hiking trails",
  outdoors: "parks and nature",
  music: "live music venues",
  nightlife: "bars and nightlife",
  culture: "museums and galleries",
  history: "historic sites",
  beach: "beaches",
  shopping: "shopping",
  relaxing: "spas",
  adventure: "outdoor adventures",
  snow: "ski and snow activities",
  holiday: "holiday lights and markets",
};

/**
 * Every search for a kind: the general one first, then the group's favourite cuisines (food) or
 * interests (activities), most wanted first, at most MAX_EXTRA_QUERIES more. A specific ask
 * ("tacos") is the only search.
 */
export function queriesFor(kind: NearbyKind, opts: { dietary?: Iterable<string>; query?: string; cuisines?: Record<string, number>; interests?: Record<string, number> }): string[] {
  if (opts.query?.trim()) return [kind === "food" ? foodQuery([], opts.query) : activityQuery(opts.query)];
  const general = kind === "food" ? foodQuery(opts.dietary ?? []) : activityQuery();
  const ranked = (w: Record<string, number> | undefined) =>
    Object.entries(w ?? {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k]) => k);
  const extra =
    kind === "food"
      ? ranked(opts.cuisines).filter((c) => c !== "anything").map((c) => foodQuery([], c))
      : ranked(opts.interests).flatMap((t) => (INTEREST_QUERY[t] ? [INTEREST_QUERY[t]!] : []));
  return [...new Set([general, ...extra.slice(0, MAX_EXTRA_QUERIES)])];
}

/** Other words a cuisine goes by on the map ("bbq" places call themselves "barbecue"). */
const CUISINE_ALIASES: Record<string, string[]> = {
  bbq: ["barbecue", "bbq", "smokehouse"],
  barbecue: ["barbecue", "bbq", "smokehouse"],
  sushi: ["sushi", "japanese"],
  ramen: ["ramen", "japanese", "noodle"],
  tacos: ["taco", "mexican", "taqueria"],
  mexican: ["mexican", "taco", "taqueria"],
  pizza: ["pizza", "pizzeria", "italian"],
  seafood: ["seafood", "fish", "oyster", "crab"],
  burgers: ["burger"],
  indian: ["indian"],
  thai: ["thai"],
  chinese: ["chinese", "dim sum", "szechuan"],
  korean: ["korean"],
  southern: ["southern", "soul food"],
  brunch: ["brunch", "breakfast"],
  coffee: ["coffee", "cafe"],
  dessert: ["dessert", "ice cream", "bakery"],
};

/** How well a restaurant matches what people said they want to eat (+ liked, − not wanted). */
export function cuisineFit(p: Pick<NearbyPlace, "name" | "category" | "types" | "description">, cuisines: Record<string, number> | undefined): number {
  if (!cuisines) return 0;
  const d = [p.name, p.category ?? "", ...p.types, p.description ?? ""].join(" ").toLowerCase();
  let fit = 0;
  for (const [c, w] of Object.entries(cuisines)) {
    if (c === "anything" || w === 0) continue;
    const words = CUISINE_ALIASES[c] ?? [c.replace(/s$/, "")];
    if (words.some((word) => new RegExp(`\\b${word.replace(/[^a-z ]/gi, "")}`, "i").test(d))) fit += w;
  }
  return fit;
}

// ---------- parsing ----------

const field = (obj: unknown, key: string): unknown => (obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const numberOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** Names and categories from the map never carry a "$" into chat or the page. */
const clean = (s: string | undefined) => s?.replace(/\$/g, "").replace(/\s+/g, " ").trim() || undefined;

/**
 * Google Maps price: "$$" (level by count) or a per-person range like "$10–20" / "$50–100" /
 * "$100+" (level by its top end).
 */
export function priceLevelOf(price: unknown): number | undefined {
  const p = text(price);
  if (!p) return undefined;
  if (/^\$+$/.test(p)) return Math.min(4, p.length);
  const nums = [...p.matchAll(/\d+/g)].map((m) => Number(m[0]));
  if (!nums.length) return undefined;
  const top = Math.max(...nums);
  return top <= 10 ? 1 : top <= 30 ? 2 : top <= 60 ? 3 : 4;
}

export const PRICE_WORDS: Record<number, string> = { 1: "cheap", 2: "mid-range", 3: "pricey", 4: "splurge" };

/** Every place in a google_maps response (local_results, or a single place_results). */
export function parseMapsResults(body: unknown, kind: NearbyKind): NearbyPlace[] {
  const list = field(body, "local_results");
  const raw = Array.isArray(list) ? list : field(body, "place_results") ? [field(body, "place_results")] : [];
  const out: NearbyPlace[] = [];
  for (const r of raw) {
    const name = clean(text(field(r, "title")));
    const id = text(field(r, "place_id")) ?? text(field(r, "data_id"));
    if (!name || !id) continue;
    const gps = field(r, "gps_coordinates");
    const types = Array.isArray(field(r, "types")) ? (field(r, "types") as unknown[]).map(text).filter((t): t is string => Boolean(t)) : [];
    const category = clean(text(field(r, "type")));
    out.push({
      kind,
      sourceId: id,
      source: "serpapi",
      name,
      ...(category ? { category } : {}),
      types: [...new Set([category, ...types.map(clean)].filter((t): t is string => Boolean(t)))],
      ...(text(field(r, "address")) ? { address: text(field(r, "address")) } : {}),
      ...(numberOf(field(gps, "latitude")) !== undefined && numberOf(field(gps, "longitude")) !== undefined
        ? { lat: numberOf(field(gps, "latitude")), lon: numberOf(field(gps, "longitude")) }
        : {}),
      ...(numberOf(field(r, "rating")) !== undefined ? { rating: numberOf(field(r, "rating")) } : {}),
      ...(numberOf(field(r, "reviews")) !== undefined ? { reviews: numberOf(field(r, "reviews")) } : {}),
      ...(priceLevelOf(field(r, "price")) ? { priceLevel: priceLevelOf(field(r, "price")) } : {}),
      ...(clean(text(field(r, "description"))) ? { description: clean(text(field(r, "description"))) } : {}),
    });
  }
  return out;
}

// ---------- distance ----------

export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.round(haversineMiles(a.lat, a.lon, b.lat, b.lon) * 1609.344);
}

/** Streets aren't straight: walking ~1.3× the straight line at 80 m/min; driving ~1.4× at city speed plus parking. */
export function travelMinutes(meters: number): { mode: "walk" | "drive"; minutes: number } {
  const walk = Math.max(1, Math.round((meters * 1.3) / 80));
  if (walk <= 20) return { mode: "walk", minutes: walk };
  const drive = Math.max(3, Math.round((meters * 1.4) / 1000 / (meters > 15_000 ? 70 : 35) * 60 + 3));
  return { mode: "drive", minutes: drive };
}

export function distanceText(meters: number | undefined): string | undefined {
  if (meters === undefined) return undefined;
  const t = travelMinutes(meters);
  return `${t.minutes} min ${t.mode}`;
}

// ---------- filtering and ranking ----------

const MEAT = /\b(steak ?house|steak|barbecue|bbq|smokehouse|chicken|wings|burger|hot dog|brisket|rotisserie|churrascaria|charcuterie)\b/i;
const SEAFOOD = /\b(seafood|oyster|fish|crab|sushi|poke)\b/i;
const PORK = /\b(barbecue|bbq|smokehouse|pork|ham|bacon)\b/i;
const VEG_FRIENDLY = /\b(vegetarian|vegan|plant[- ]based|veggie|indian|falafel|mediterranean|middle eastern|ethiopian)\b/i;
const VEGAN = /\b(vegan|plant[- ]based)\b/i;
const HALAL = /\b(halal|middle eastern|turkish|lebanese|pakistani|afghan|persian)\b/i;
const KOSHER = /\b(kosher|deli)\b/i;
const GLUTEN_FREE = /\b(gluten[- ]free|celiac)\b/i;

const describe = (p: NearbyPlace) => [p.name, p.category, ...p.types, p.description ?? ""].join(" ");

/** True when a restaurant clearly doesn't work for a need (a steakhouse for a vegetarian). */
export function failsDiet(p: NearbyPlace, needs: ReadonlySet<string>): boolean {
  const kind = [p.category, ...p.types].join(" ");
  if (VEG_FRIENDLY.test(kind)) return false;
  if ((needs.has("vegetarian") || needs.has("vegan")) && (MEAT.test(kind) || SEAFOOD.test(kind))) return true;
  if (needs.has("pescatarian") && MEAT.test(kind)) return true;
  if ((needs.has("halal") || needs.has("kosher")) && PORK.test(kind)) return true;
  return false;
}

/** How well a restaurant serves the group's needs: 0 (nothing special) to 1 (built for it). */
export function dietFit(p: NearbyPlace, needs: ReadonlySet<string>): number {
  if (!needs.size) return 0;
  const d = describe(p);
  let hits = 0;
  let wanted = 0;
  for (const n of needs) {
    const re = n === "vegan" ? VEGAN : n === "vegetarian" || n === "pescatarian" ? VEG_FRIENDLY : n === "halal" ? HALAL : n === "kosher" ? KOSHER : n === "gluten_free" ? GLUTEN_FREE : undefined;
    if (!re) continue;
    wanted += 1;
    if (re.test(d)) hits += 1;
  }
  return wanted ? hits / wanted : 0;
}

/** Map categories onto the profile's activity tags. */
const TAG_WORDS: Record<string, RegExp> = {
  outdoors: /\b(park|garden|arboretum|trail|hiking|nature|scenic|lake|river|falls|waterfall|beach|preserve|outdoor)\b/i,
  hiking: /\b(trail|hiking|trailhead|mountain|summit|falls)\b/i,
  mountains: /\b(mountain|summit|peak|overlook|parkway)\b/i,
  beach: /\b(beach|shore|pier|boardwalk)\b/i,
  culture: /\b(museum|gallery|art|theat(?:er|re)|cultural|studio|landmark)\b/i,
  history: /\b(historic(?:al)?|history|landmark|estate|fort|monument|memorial|museum)\b/i,
  music: /\b(music|concert|venue|jazz|club|amphitheat(?:er|re))\b/i,
  nightlife: /\b(bar|brewpub|brewery|pub|night ?club|club|lounge|cocktail|winery)\b/i,
  food: /\b(food|market|brewery|brewpub|winery|tasting|chocolate|bakery)\b/i,
  shopping: /\b(shop|store|market|boutique|mall|book ?store)\b/i,
  relaxing: /\b(spa|hot springs?|garden|park|bookstore|book store|cafe)\b/i,
  adventure: /\b(zip ?line|rafting|tubing|climbing|kayak|adventure|ropes)\b/i,
  city: /\b(downtown|square|district|plaza|tourist attraction)\b/i,
  walkable: /\b(district|square|walking|downtown)\b/i,
};

export function activityTags(p: NearbyPlace): string[] {
  if (p.tags?.length) return p.tags;
  const d = [p.category, ...p.types, p.description ?? ""].join(" ");
  return Object.entries(TAG_WORDS)
    .filter(([, re]) => re.test(d))
    .map(([tag]) => tag);
}

export function settingOf(p: NearbyPlace): "outdoor" | "indoor" | "either" {
  if (p.setting) return p.setting;
  if (p.kind === "food") return "indoor";
  const d = [p.category, ...p.types].join(" ");
  if (/\b(park|garden|arboretum|trail|hiking|scenic|beach|falls|overlook|lake|preserve)\b/i.test(d)) return "outdoor";
  if (/\b(museum|gallery|theat|venue|store|shop|spa|bar|pub|brew|cafe|aquarium|cinema|bowling|arcade)\b/i.test(d)) return "indoor";
  return "either";
}

export interface RankOptions {
  origin?: { lat: number; lon: number };
  /** Dietary needs anyone in the group has. */
  dietary?: Iterable<string>;
  /** Tag → weight: + per person who likes it, − per person who doesn't. */
  interests?: Record<string, number>;
  /** Cuisine → weight, the same way ("thai": 2 when two people want thai). */
  cuisines?: Record<string, number>;
  /** People with low mobility: keep it close. */
  lowMobility?: boolean;
  /** Already picked or shown: skip. */
  exclude?: ReadonlySet<string>;
  limit?: number;
}

/** Filter for the group and pick the best few: rating and review count, fit, distance. */
export function rankPlaces(places: NearbyPlace[], opts: RankOptions = {}): NearbyPlace[] {
  const needs = new Set(opts.dietary ?? []);
  const weights = opts.interests ?? {};
  const seen = new Set<string>();
  const withDistance = places
    .filter((p) => !opts.exclude?.has(p.sourceId) && !opts.exclude?.has(p.name.toLowerCase()))
    .filter((p) => {
      const key = p.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((p) => (opts.origin && p.lat !== undefined && p.lon !== undefined ? { ...p, distanceM: distanceMeters(opts.origin, { lat: p.lat, lon: p.lon }) } : p));

  const fitting = withDistance.filter((p) => !(p.kind === "food" && failsDiet(p, needs)));
  const disliked = (p: NearbyPlace) => activityTags(p).some((t) => (weights[t] ?? 0) < 0 && !activityTags(p).some((u) => (weights[u] ?? 0) > 0));
  const liked = fitting.filter((p) => p.kind === "food" || !disliked(p));
  const rated = liked.filter((p) => p.rating === undefined || p.rating >= MIN_RATING);
  const pool = rated.length >= Math.min(opts.limit ?? SHORTLIST_SIZE, liked.length) ? rated : liked;

  const score = (p: NearbyPlace): number => {
    let s = (p.rating ?? 4.2) + Math.log10((p.reviews ?? 50) + 1) * 0.15;
    if (p.kind === "food") s += dietFit(p, needs) * 0.6 + Math.max(-1.5, Math.min(1.2, cuisineFit(p, opts.cuisines) * 0.4));
    else s += Math.max(-1, Math.min(1.5, activityTags(p).reduce((sum, t) => sum + (weights[t] ?? 0), 0) * 0.4));
    if (p.distanceM !== undefined) {
      const km = p.distanceM / 1000;
      const free = opts.lowMobility ? 1 : p.kind === "food" ? 2 : 8;
      if (km > free) s -= (km - free) * (p.kind === "food" || opts.lowMobility ? 0.25 : 0.03);
    }
    return s;
  };
  const ranked = pool.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name));
  const limit = opts.limit ?? SHORTLIST_SIZE;
  const top = ranked.slice(0, limit);
  // Every cuisine someone asked for gets a spot when there's a place for it ("tacos" from leo
  // shouldn't lose all five slots to the vegetarian places): it takes the lowest slot that isn't
  // one of the asked-for cuisines.
  const asked = Object.entries(opts.cuisines ?? {})
    .filter(([c, w]) => w > 0 && c !== "anything")
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c);
  const fits = (p: NearbyPlace, c: string) => p.kind === "food" && cuisineFit(p, { [c]: 1 }) > 0;
  for (const c of asked) {
    if (top.some((x) => fits(x.p, c))) continue;
    const best = ranked.slice(limit).find((x) => fits(x.p, c));
    const slot = [...top.keys()].reverse().find((i) => !asked.some((a) => fits(top[i]!.p, a)));
    if (best && slot !== undefined) top[slot] = best;
  }
  return top.sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name)).map((x) => x.p);
}

/** "4.7★, mid-range, 6 min walk" (whatever is known). */
export function placeFacts(p: Pick<NearbyPlace, "rating" | "priceLevel" | "distanceM" | "category">, withCategory = false): string {
  const parts = [
    withCategory && p.category ? p.category.toLowerCase() : undefined,
    p.rating !== undefined ? `${p.rating.toFixed(1)}★` : undefined,
    p.priceLevel ? PRICE_WORDS[p.priceLevel] : undefined,
    distanceText(p.distanceM),
  ].filter(Boolean);
  return parts.join(", ");
}

// ---------- offline fallback ----------

/** The destination's catalog activities as places (no rating or distance; nothing to look up). */
export function catalogPlaces(dest: Destination | undefined, kind: NearbyKind): NearbyPlace[] {
  if (!dest) return [];
  return dest.activities
    .filter((a) => (kind === "food" ? a.tags.includes("food") : true))
    .map((a) => ({
      kind,
      sourceId: `catalog:${a.id}`,
      source: "catalog" as const,
      name: a.name,
      types: [],
      setting: a.setting,
      tags: [...a.tags],
    }));
}

// ---------- the client ----------

const stubs = new Map<NearbyKind, unknown>();

/** Answer every search of a kind with this response, no network (simulator scenarios, tests). */
export function stubNearby(kind: NearbyKind, body: unknown): void {
  stubs.set(kind, body);
}

export function clearNearbyStubs(): void {
  stubs.clear();
}

async function mapsSearch(params: Record<string, string>, deps: PriceDeps): Promise<unknown | undefined> {
  const key = cacheKey(params);
  try {
    const hit = await deps.cache.get(key);
    if (hit && deps.now().getTime() - new Date(hit.fetchedAt).getTime() <= (deps.maxAgeMs ?? NEARBY_MAX_AGE_MS)) return hit.body;
  } catch {
    // A broken cache is a miss.
  }
  if (!deps.apiKey) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await deps.fetch(serpApiUrl(params, deps.apiKey), { signal: controller.signal });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    if (!body || typeof body !== "object" || "error" in body) return undefined;
    try {
      await deps.cache.set(key, body, deps.now());
    } catch {
      // Caching is best-effort.
    }
    return body;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface NearbyResult {
  places: NearbyPlace[];
  /** Where the list came from: the live map, or the catalog because the map wasn't reachable. */
  source: "serpapi" | "catalog" | "none";
  query: string;
}

/**
 * Search around the origin for one kind and rank for the group. Falls back to the destination's
 * catalog activities when the map can't be reached.
 */
export async function searchNearby(
  kind: NearbyKind,
  origin: Origin,
  opts: RankOptions & { dest?: Destination; query?: string },
  deps: PriceDeps,
): Promise<NearbyResult> {
  const queries = queriesFor(kind, opts);
  const query = queries[0]!;
  // Each search on its own (one failing doesn't sink the rest); duplicates merge in the ranking.
  const bodies = await Promise.all(
    queries.map(async (qy) => {
      try {
        return stubs.has(kind) ? stubs.get(kind) : await mapsSearch(mapsSearchParams(qy, origin), deps);
      } catch {
        return undefined;
      }
    }),
  );
  const live = bodies.flatMap((body) => (body ? parseMapsResults(body, kind) : []));
  if (live.length) return { places: rankPlaces(live, { ...opts, origin }), source: "serpapi", query };
  const offline = catalogPlaces(opts.dest, kind);
  if (offline.length) return { places: rankPlaces(offline, { ...opts, origin }), source: "catalog", query };
  return { places: [], source: "none", query };
}
