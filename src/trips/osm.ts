// Places near the stay from OpenStreetMap, through Photon (photon.komoot.io): free, no key, and
// not a scraped search page, so it isn't rate-limited away like the web search. It matches words
// against place names, so it answers specific asks ("indian", "sushi", "museum") well and generic
// ones ("restaurant") badly: it runs only when there's something specific to look for. No ratings
// or prices; distances come from the coordinates. Never throws.
import { LRUCache } from "lru-cache";
import { childLog } from "../log.ts";
import type { NearbyKind, NearbyPlace, Origin } from "./nearby.ts";

const log = childLog({ component: "osm" });
const PHOTON = "https://photon.komoot.io/api/";
const TIMEOUT_MS = 6_000;
/** Half the side of the search box, in degrees of latitude (~25 km). */
const BOX_DEG = 0.22;

const TAGS: Record<NearbyKind, string[]> = {
  food: ["amenity:restaurant", "amenity:fast_food", "amenity:cafe", "amenity:food_court", "amenity:ice_cream", "amenity:bar", "amenity:pub"],
  activity: ["tourism", "leisure:park", "leisure:water_park", "leisure:nature_reserve", "leisure:garden", "leisure:stadium", "amenity:theatre", "amenity:arts_centre", "amenity:cinema", "amenity:nightclub", "natural:beach"],
};
// Tourism tags that aren't things to do.
const NOT_ACTIVITY = new Set(["hotel", "motel", "hostel", "guest_house", "apartment", "chalet", "camp_site", "caravan_site", "information"]);

type Fetch = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
let osmFetch: Fetch | undefined;
/** Tests inject a fetch (or one that throws); undefined restores the global. */
export function setOsmFetch(f: Fetch | undefined): void {
  osmFetch = f;
}

const cache = new LRUCache<string, NearbyPlace[]>({ max: 200, ttl: 24 * 3_600_000 });

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: { osm_type?: string; osm_id?: number; osm_key?: string; osm_value?: string; name?: string; street?: string; housenumber?: string; city?: string };
}

/** One Photon search for `term` in a box around the origin, as places of `kind`. */
export async function photonSearch(kind: NearbyKind, term: string, origin: Origin): Promise<NearbyPlace[]> {
  const key = `${kind}|${term.toLowerCase()}|${origin.lat.toFixed(2)},${origin.lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const lonDeg = BOX_DEG / Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180));
  const params = new URLSearchParams({
    q: term,
    lat: String(origin.lat),
    lon: String(origin.lon),
    limit: "15",
    lang: "en",
    bbox: [origin.lon - lonDeg, origin.lat - BOX_DEG, origin.lon + lonDeg, origin.lat + BOX_DEG].map((n) => n.toFixed(4)).join(","),
  });
  for (const t of TAGS[kind]) params.append("osm_tag", t);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const f: Fetch = osmFetch ?? ((input, init) => globalThis.fetch(input, init));
    const res = await f(`${PHOTON}?${params}`, { signal: controller.signal, headers: { "user-agent": "atlas-trip-planner/0.1 (group trip planner)" } });
    if (!res.ok) return [];
    const body = (await res.json()) as { features?: PhotonFeature[] };
    const places = (body.features ?? []).flatMap((ft): NearbyPlace[] => {
      const p = ft.properties ?? {};
      const [lon, lat] = ft.geometry?.coordinates ?? [];
      const name = p.name?.replace(/\$/g, "").trim();
      if (!name || typeof lat !== "number" || typeof lon !== "number" || !p.osm_id) return [];
      if (kind === "activity" && p.osm_key === "tourism" && NOT_ACTIVITY.has(p.osm_value ?? "")) return [];
      const category = (p.osm_value ?? "").replace(/_/g, " ") || undefined;
      const address = [p.housenumber, p.street, p.city].filter(Boolean).join(" ") || undefined;
      return [{ kind, sourceId: `osm:${p.osm_type ?? ""}${p.osm_id}`, source: "osm", name, types: category ? [category, term] : [term], ...(category ? { category } : {}), ...(address ? { address } : {}), lat, lon }];
    });
    cache.set(key, places);
    return places;
  } catch (err) {
    log.warn({ kind, term, err: (err as Error).message.slice(0, 120) }, "photon search failed");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Every term searched at once, merged (the caller ranks and dedupes). */
export async function osmPlaces(kind: NearbyKind, terms: string[], origin: Origin): Promise<NearbyPlace[]> {
  const lists = await Promise.all(terms.slice(0, 3).map((t) => photonSearch(kind, t, origin)));
  return lists.flat();
}
