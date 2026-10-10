// The trip row for a chat: one trip per group chat, created on first use.
import { now } from "../clock.ts";
import { db, one, q, type Queryable } from "../db/pool.ts";

export type TripStatus = "planning" | "voting" | "locked" | "ongoing" | "settling" | "done";

export interface ItineraryDay {
  date: string;
  items: { activityId: string; name: string; setting: "outdoor" | "indoor" | "either"; costCents: number; tags?: string[] }[];
}

export interface TripRow {
  id: number;
  chat_id: number;
  status: TripStatus;
  destination_id: string | null;
  destination_name: string | null;
  latitude: number | null;
  longitude: number | null;
  start_date: string | null;
  end_date: string | null;
  deposit_deadline: string | null;
  split_mode: "by_cost" | "even";
  itinerary: ItineraryDay[];
  locked_at: Date | null;
}

export async function tripFor(chatId: number, on: Queryable = db()): Promise<TripRow> {
  const at = now();
  const row = await one<TripRow>(
    `INSERT INTO trips (chat_id, created_at, updated_at) VALUES ($1, $2, $2)
     ON CONFLICT (chat_id) DO UPDATE SET chat_id = EXCLUDED.chat_id RETURNING *`,
    [chatId, at],
    on,
  );
  return row!;
}

export async function updateTrip(tripId: number, patch: Partial<Omit<TripRow, "id" | "chat_id">>, on: Queryable = db()): Promise<TripRow> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return (await one<TripRow>(`SELECT * FROM trips WHERE id = $1`, [tripId], on))!;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => (k === "itinerary" ? JSON.stringify(patch[k]) : patch[k]));
  const row = await one<TripRow>(
    `UPDATE trips SET ${sets.join(", ")}, updated_at = $${keys.length + 2} WHERE id = $1 RETURNING *`,
    [tripId, ...values, now()],
    on,
  );
  return row!;
}

/** Trips that are underway or locked and need the clock to move them (ongoing on start, settling after end). */
export async function advanceTripStatus(trip: TripRow, today: string): Promise<TripRow> {
  if (!trip.start_date || !trip.end_date) return trip;
  if (trip.status === "locked" && today >= trip.start_date) return updateTrip(trip.id, { status: "ongoing" });
  if (trip.status === "ongoing" && today > trip.end_date) return updateTrip(trip.id, { status: "settling" });
  return trip;
}

export async function tripsToWatch(): Promise<TripRow[]> {
  return q<TripRow>(`SELECT * FROM trips WHERE status IN ('locked','ongoing') AND latitude IS NOT NULL AND start_date IS NOT NULL`);
}
