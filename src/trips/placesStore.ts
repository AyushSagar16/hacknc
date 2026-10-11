// trip_places: the shortlists Atlas posted (numbered, so "add 2" works) and the places the group
// picked, with the itinerary day each pick landed on.
import { db, one, q, type Queryable } from "../db/pool.ts";
import type { NearbyKind, NearbyPlace } from "./nearby.ts";

export interface TripPlaceRow {
  id: number;
  trip_id: number;
  kind: NearbyKind;
  idx: number | null;
  name: string;
  category: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  rating: number | null;
  reviews: number | null;
  price_level: number | null;
  distance_m: number | null;
  source: "serpapi" | "catalog";
  source_id: string;
  status: "suggested" | "picked";
  picked_by: number | null;
  picked_at: Date | null;
  day: string | null;
  added_at: Date;
}

const COLUMNS = `id, trip_id, kind, idx, name, category, address, lat, lon, rating, reviews, price_level, distance_m, source, source_id, status, picked_by, picked_at, to_char(day, 'YYYY-MM-DD') AS day, added_at`;

export async function placesFor(tripId: number, on: Queryable = db()): Promise<TripPlaceRow[]> {
  return q<TripPlaceRow>(`SELECT ${COLUMNS} FROM trip_places WHERE trip_id = $1 ORDER BY idx NULLS LAST, id`, [tripId], on);
}

/**
 * Save a new shortlist numbered from `startIdx`. Earlier suggestions of the same kind that nobody
 * picked are dropped; picks are kept (and keep their number only if this list doesn't reuse it).
 */
export async function saveShortlist(tripId: number, kind: NearbyKind, places: NearbyPlace[], startIdx: number, at: Date, on: Queryable = db()): Promise<TripPlaceRow[]> {
  await q(`DELETE FROM trip_places WHERE trip_id = $1 AND kind = $2 AND status = 'suggested'`, [tripId, kind], on);
  const numbers = places.map((_, i) => startIdx + i);
  await q(`UPDATE trip_places SET idx = NULL WHERE trip_id = $1 AND idx = ANY($2::int[])`, [tripId, numbers], on);
  const rows: TripPlaceRow[] = [];
  for (const [i, p] of places.entries()) {
    const row = await one<TripPlaceRow>(
      `INSERT INTO trip_places (trip_id, kind, idx, name, category, address, lat, lon, rating, reviews, price_level, distance_m, source, source_id, added_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (trip_id, source_id) DO UPDATE SET idx = EXCLUDED.idx, distance_m = EXCLUDED.distance_m, rating = EXCLUDED.rating, reviews = EXCLUDED.reviews
       RETURNING ${COLUMNS}`,
      [tripId, kind, startIdx + i, p.name, p.category ?? null, p.address ?? null, p.lat ?? null, p.lon ?? null, p.rating ?? null, p.reviews ?? null, p.priceLevel ?? null, p.distanceM ?? null, p.source, p.sourceId, at],
      on,
    );
    rows.push(row!);
  }
  return rows;
}

export async function markPicked(id: number, by: number | null, day: string | null, at: Date, on: Queryable = db()): Promise<void> {
  await q(`UPDATE trip_places SET status = 'picked', picked_by = $2, picked_at = $3, day = $4 WHERE id = $1`, [id, by, at, day], on);
}

/** Forget a trip's places (the place or dates changed). */
export async function clearPlaces(tripId: number, on: Queryable = db()): Promise<void> {
  await q(`DELETE FROM trip_places WHERE trip_id = $1`, [tripId], on);
}
