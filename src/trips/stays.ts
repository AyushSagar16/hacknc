// Where to stay: SerpApi google_hotels for hotels and (vacation_rentals=true) whole-home rentals
// at the destination for the trip's dates, sized for the group, filtered to what the group can
// afford, and narrowed to three named options (the cheapest, the best rated, a rental when one
// fits). With no SerpApi key and nothing cached, the options are labeled estimates from the
// destination's catalog costs, so the stay stage works offline. Nothing here throws on a bad
// response; it just yields fewer options.
import { daysBetween } from "../clock.ts";
import type { Destination } from "./catalog.ts";
import { googleHotelsLink } from "./links.ts";
import { search, type PriceDeps } from "./pricing.ts";

export type StayKind = "hotel" | "rental";

export interface StayOption {
  name: string;
  kind: StayKind;
  /** The whole group, all nights (rooms × room total for hotels). */
  totalCents: number;
  perPersonNightCents: number;
  perPersonCents: number;
  /** Hotel rooms booked for the group (2 per room); 1 for a rental. */
  rooms: number;
  /** For rentals: how many it sleeps. */
  sleeps: number | null;
  rating: number | null;
  reviews: number | null;
  link: string;
  lat: number | null;
  lon: number | null;
  /** "live" from SerpApi, "estimate" from the catalog. */
  source: "live" | "estimate";
  overBudget?: boolean;
}

/** People per hotel room. */
export const PEOPLE_PER_ROOM = 2;

export function staySearchParams(destName: string, start: string, end: string, adults: number, rentals: boolean): Record<string, string> {
  return {
    engine: "google_hotels",
    q: rentals ? destName : `${destName} hotels`,
    check_in_date: start,
    check_out_date: end,
    adults: String(rentals ? Math.max(1, adults) : PEOPLE_PER_ROOM),
    currency: "USD",
    hl: "en",
    gl: "us",
    ...(rentals ? { vacation_rentals: "true" } : {}),
  };
}

const field = (obj: unknown, key: string): unknown => (obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined);
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** "Sleeps 8" / "8 guests" from a rental's essential_info; else 2 per bed or bedroom. */
export function sleepsOf(p: unknown): number | null {
  const info = field(p, "essential_info");
  const lines = Array.isArray(info) ? info.filter((x): x is string => typeof x === "string") : [];
  for (const l of lines) {
    const m = /\bsleeps\s+(\d+)|\b(\d+)\s+guests?\b/i.exec(l);
    if (m) return Number(m[1] ?? m[2]);
  }
  for (const re of [/\b(\d+)\s+beds?\b/i, /\b(\d+)\s+bedrooms?\b/i]) {
    const hit = lines.map((l) => re.exec(l)).find(Boolean);
    if (hit) return Number(hit[1]) * 2;
  }
  return null;
}

/**
 * Every priced property in a google_hotels response, sized for `groupSize`: a hotel needs
 * ceil(n/2) rooms, a rental must sleep everyone (one that's too small is dropped).
 */
export function parseStays(body: unknown, opts: { nights: number; groupSize: number; fallbackLink: string }): StayOption[] {
  const props = field(body, "properties");
  if (!Array.isArray(props)) return [];
  const n = Math.max(1, opts.groupSize);
  const nights = Math.max(1, opts.nights);
  const out: StayOption[] = [];
  for (const p of props) {
    const name = field(p, "name");
    if (typeof name !== "string" || !name.trim()) continue;
    const type = String(field(p, "type") ?? "").toLowerCase();
    const kind: StayKind = /rental|home|apartment|villa|cabin|house|condo/.test(type) ? "rental" : "hotel";
    const total = field(field(p, "total_rate"), "extracted_lowest");
    const nightly = field(field(p, "rate_per_night"), "extracted_lowest");
    const unitUsd = positive(total) ? total : positive(nightly) ? nightly * nights : undefined;
    if (unitUsd === undefined) continue;
    let rooms = 1;
    let sleeps: number | null = null;
    if (kind === "rental") {
      sleeps = sleepsOf(p);
      if (sleeps !== null && sleeps < n) continue;
    } else rooms = Math.ceil(n / PEOPLE_PER_ROOM);
    const totalCents = Math.round(unitUsd * 100) * rooms;
    const perPersonCents = Math.round(totalCents / n);
    const rating = field(p, "overall_rating");
    const reviews = field(p, "reviews");
    const gps = field(p, "gps_coordinates");
    const link = field(p, "link");
    out.push({
      name: name.trim(),
      kind,
      totalCents,
      perPersonCents,
      perPersonNightCents: Math.round(totalCents / n / nights),
      rooms,
      sleeps,
      rating: positive(rating) ? rating : null,
      reviews: positive(reviews) ? reviews : null,
      link: typeof link === "string" && /^https?:\/\//.test(link) ? link : opts.fallbackLink,
      lat: typeof field(gps, "latitude") === "number" ? (field(gps, "latitude") as number) : null,
      lon: typeof field(gps, "longitude") === "number" ? (field(gps, "longitude") as number) : null,
      source: "live",
    });
  }
  return out;
}

/**
 * Three options: within `capPerPersonCents` (each person's whole stay) when given; the cheapest,
 * the best rated, and a rental (or the next best value). When nothing fits, the three cheapest,
 * flagged over budget.
 */
export function pickStays(all: StayOption[], capPerPersonCents: number | null, count = 3): StayOption[] {
  const seen = new Set<string>();
  const unique = all.filter((s) => {
    const key = s.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const byPrice = [...unique].sort((a, b) => a.perPersonCents - b.perPersonCents || (b.rating ?? 0) - (a.rating ?? 0));
  const fits = capPerPersonCents === null ? byPrice : byPrice.filter((s) => s.perPersonCents <= capPerPersonCents);
  if (fits.length === 0) return byPrice.slice(0, count).map((s) => ({ ...s, overBudget: true }));
  const picks: StayOption[] = [];
  const add = (s: StayOption | undefined) => {
    if (s && !picks.includes(s) && picks.length < count) picks.push(s);
  };
  add(fits[0]);
  add([...fits].filter((s) => s.rating !== null).sort((a, b) => b.rating! - a.rating! || a.perPersonCents - b.perPersonCents)[0]);
  add(fits.find((s) => s.kind === "rental" && !picks.includes(s)));
  // Then the best value: rating per dollar.
  for (const s of [...fits].sort((a, b) => (b.rating ?? 3) / b.perPersonCents - (a.rating ?? 3) / a.perPersonCents)) add(s);
  return picks.sort((a, b) => a.perPersonCents - b.perPersonCents);
}

/** Labeled estimates from the catalog's lodging costs when no live prices are available. */
export function estimatedStays(dest: Destination, dates: { start: string; end: string }, groupSize: number): StayOption[] {
  const n = Math.max(1, groupSize);
  const nights = Math.max(1, daysBetween(dates.start, dates.end));
  const link = googleHotelsLink(dest.name, dates.start, dates.end, n);
  const place = dest.name.split(",")[0]!.trim();
  const mk = (name: string, kind: StayKind, perNightPp: number, rooms: number, sleeps: number | null): StayOption => {
    const perPersonNightCents = Math.round(perNightPp / 100) * 100;
    const totalCents = perPersonNightCents * n * nights;
    return { name, kind, totalCents, perPersonCents: perPersonNightCents * nights, perPersonNightCents, rooms, sleeps, rating: null, reviews: null, link, lat: dest.lat, lon: dest.lon, source: "estimate" };
  };
  const { budget, mid } = dest.costs.lodgingPerNightCents;
  const rooms = Math.ceil(n / PEOPLE_PER_ROOM);
  return [
    mk(`${place} rental for ${n} (est.)`, "rental", budget * 0.85, 1, n),
    mk(`${place} budget hotel (est.)`, "hotel", budget, rooms, null),
    mk(`${place} mid-range hotel (est.)`, "hotel", mid, rooms, null),
  ];
}

let fixture: { hotels?: unknown; rentals?: unknown } | undefined;
/** The simulator answers stay searches from fixture files (src/sim/staysExtension.ts). */
export function setStayFixture(f: { hotels?: unknown; rentals?: unknown } | undefined): void {
  fixture = f;
}

/**
 * Hotels and rentals at the destination for these dates, sized for the group: live when SerpApi
 * answers (or a cached answer exists), else estimates. `capPerPersonCents` filters to budget.
 */
export async function findStays(dest: Destination, dates: { start: string; end: string }, groupSize: number, capPerPersonCents: number | null, deps: PriceDeps): Promise<{ options: StayOption[]; live: boolean }> {
  const nights = Math.max(1, daysBetween(dates.start, dates.end));
  const fallbackLink = googleHotelsLink(dest.name, dates.start, dates.end, groupSize);
  let bodies: unknown[] = [];
  if (fixture) bodies = [fixture.hotels, fixture.rentals].filter(Boolean);
  else {
    try {
      const [hotels, rentals] = await Promise.all([
        search(staySearchParams(dest.name, dates.start, dates.end, groupSize, false), deps),
        search(staySearchParams(dest.name, dates.start, dates.end, groupSize, true), deps),
      ]);
      bodies = [hotels?.body, rentals?.body].filter(Boolean);
    } catch {
      bodies = [];
    }
  }
  const all = bodies.flatMap((b) => parseStays(b, { nights, groupSize, fallbackLink }));
  if (all.length === 0) return { options: pickStays(estimatedStays(dest, dates, groupSize), capPerPersonCents), live: false };
  return { options: pickStays(all, capPerPersonCents), live: true };
}
