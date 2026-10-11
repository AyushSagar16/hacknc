// Photos of the places a trip visits, from Wikipedia's page images (Wikimedia Commons). No key
// needed. Lookups are cached for a week; any failure just means no photo, never a broken page.
import "server-only";
import { unstable_cache } from "next/cache";

export interface Photo {
  src: string;
  alt: string;
}

const API = "https://en.wikipedia.org/w/api.php";
const UA = "AtlasTrips/0.1 (trip pages; https://github.com/AyushSagar16/hacknc)";
// Page images that aren't photos of the place: flags, maps, seals, logos, diagrams.
const NOT_A_PHOTO = /flag|map|locator|location|logo|seal|coat_of_arms|emblem|symbol|icon|diagram|chart|\.svg$|\.png$|\.gif$/i;
const STOP = new Set(["the", "and", "in", "at", "of", "by", "to", "on", "for", "with", "a", "an", "day", "trip", "tour", "dinner", "lunch", "breakfast", "visit"]);

interface WikiPage {
  title: string;
  index?: number;
  pageimage?: string;
  thumbnail?: { source: string };
  pageprops?: { disambiguation?: string };
}

async function query(params: Record<string, string>): Promise<WikiPage[]> {
  const url = `${API}?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", redirects: "1", ...params })}`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) return [];
  const body = (await res.json()) as { query?: { pages?: WikiPage[] } };
  return body.query?.pages ?? [];
}

const IMAGE_PROPS = { prop: "pageimages|pageprops", piprop: "thumbnail|name", ppprop: "disambiguation" };

const usable = (p: WikiPage | undefined): p is WikiPage & { thumbnail: { source: string } } =>
  Boolean(p?.thumbnail?.source && p.pageimage && !NOT_A_PHOTO.test(p.pageimage) && !p.pageprops?.disambiguation);

/** "Cairo & Luxor" → ["Cairo", "Luxor"]. */
export function placeParts(place: string): string[] {
  return place
    .split(/\s*(?:&|\+|,|\/|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A photo for a named place: its own page, else "Tourism in …" (country pages lead with a flag). */
async function placePhotoUncached(name: string, width: number): Promise<Photo | null> {
  const titles = [name, `Tourism in ${name}`];
  try {
    const pages = await query({ ...IMAGE_PROPS, pithumbsize: String(width), titles: titles.join("|") });
    for (const t of titles) {
      const page = pages.find((p) => p.title.toLowerCase() === t.toLowerCase()) ?? (t === name ? pages.find((p) => !p.title.startsWith("Tourism in")) : undefined);
      if (usable(page)) return { src: page.thumbnail.source, alt: name };
    }
  } catch {}
  return null;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

/** A photo for an itinerary stop, but only when Wikipedia's best match is clearly the same thing. */
async function stopPhotoUncached(name: string, place: string, width: number): Promise<Photo | null> {
  const wanted = new Set(words(name));
  if (!wanted.size) return null;
  try {
    const pages = await query({ ...IMAGE_PROPS, pithumbsize: String(width), generator: "search", gsrsearch: `${name} ${place}`.trim(), gsrlimit: "3" });
    const best = pages
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .find((p) => usable(p) && words(p.title).some((w) => wanted.has(w)));
    return usable(best) ? { src: best.thumbnail.source, alt: name } : null;
  } catch {
    return null;
  }
}

const WEEK = 7 * 24 * 60 * 60;
export const placePhoto = unstable_cache(placePhotoUncached, ["place-photo-v1"], { revalidate: WEEK });
export const stopPhoto = unstable_cache(stopPhotoUncached, ["stop-photo-v1"], { revalidate: WEEK });

/** A photo for a place that may name several ("Cairo & Luxor"): the first part that has one. */
export async function placesPhoto(name: string, width: number): Promise<Photo | null> {
  for (const part of placeParts(name)) {
    const photo = await placePhoto(part, width);
    if (photo) return { ...photo, alt: name };
  }
  return null;
}

/** The trip's cover: its destination, else its title. */
export async function coverPhoto(trip: { destination: string | null; title: string }): Promise<Photo | null> {
  return (await placesPhoto(trip.destination ?? trip.title, 1600)) ?? (trip.destination ? placePhoto(trip.title, 1600) : null);
}

/** One photo per day: the first stop that has one. */
export async function dayPhotos(days: { items: { name: string }[] }[], place: string): Promise<(Photo | null)[]> {
  const region = placeParts(place)[0] ?? "";
  return Promise.all(
    days.map(async (d) => {
      for (const item of d.items.slice(0, 3)) {
        const photo = await stopPhoto(item.name, region, 800);
        if (photo) return photo;
      }
      return null;
    }),
  );
}
