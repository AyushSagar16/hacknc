// Trips for a chat. A chat can plan several trips; it works on one focused trip at a time
// (chats.focus_trip_id), created on first use. Each trip's public_id is its page URL.
import { now } from "../clock.ts";
import { db, one, q, type Queryable } from "../db/pool.ts";

export type TripStatus = "planning" | "voting" | "locked" | "ongoing" | "settling" | "done";

/**
 * A day of the plan. Atlas writes it (update_itinerary); items that match a catalog activity keep
 * its id and cost, the rest are `custom:` items with no cost.
 */
export interface ItineraryDay {
  date: string;
  title?: string;
  items: {
    activityId: string;
    name: string;
    setting: "outdoor" | "indoor" | "either";
    costCents: number;
    tags?: string[];
    /** "9am", "morning", "after dinner". */
    time?: string;
    notes?: string;
  }[];
}

export interface TripRow {
  id: number;
  chat_id: number;
  public_id: string;
  title: string | null;
  summary: string | null;
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
  /** When the day-by-day plan was written (update_itinerary, or the catalog fallback). */
  plan_written_at?: Date | null;
  locked_at: Date | null;
  site_version: number;
  booking: { label: string; url: string }[];
  site_message_cursor: number;
  /** Where each stage of the plan stands (src/trips/stages.ts); absent keys are inferred. */
  stages?: Partial<Record<"location" | "dates" | "travel" | "stay" | "food_activities", "open" | "in_progress" | "decided">>;
  /** An off-catalog place locked by name (geocoded); destination_id is null then. */
  destination_place?: TripPlace | null;
  /** The booked stay (written by the stay workstream). */
  stay?: TripStay | null;
  created_at: Date;
}

/** A geocoded place that isn't in the destination catalog. */
export interface TripPlace {
  name: string;
  admin1?: string;
  country?: string;
  countryCode?: string;
  lat: number;
  lon: number;
  timezone?: string;
}

export interface TripStay {
  name: string;
  kind: "hotel" | "rental";
  address?: string | null;
  lat?: number | null;
  lon?: number | null;
  check_in?: string | null;
  check_out?: string | null;
  total_cents?: number | null;
  per_person_night_cents?: number | null;
  rating?: number | null;
  link?: string | null;
  booked_at?: string | null;
}

/** The chat's focused trip; the first one is created (and focused) on first use. */
export async function tripFor(chatId: number, on: Queryable = db()): Promise<TripRow> {
  const focused = await one<TripRow>(`SELECT t.* FROM chats c JOIN trips t ON t.id = c.focus_trip_id WHERE c.id = $1`, [chatId], on);
  if (focused) return focused;
  // Compare-and-set the focus so two concurrent first turns don't leave two trips.
  const at = now();
  const row = (await one<TripRow>(`INSERT INTO trips (chat_id, created_at, updated_at) VALUES ($1, $2, $2) RETURNING *`, [chatId, at], on))!;
  const claimed = await one(`UPDATE chats SET focus_trip_id = $2 WHERE id = $1 AND focus_trip_id IS NULL RETURNING id`, [chatId, row.id], on);
  if (claimed) return row;
  await q(`DELETE FROM trips WHERE id = $1`, [row.id], on);
  return (await one<TripRow>(`SELECT t.* FROM chats c JOIN trips t ON t.id = c.focus_trip_id WHERE c.id = $1`, [chatId], on))!;
}

/** Start a new trip in a chat and focus it. */
export async function createTrip(chatId: number, title: string | null, on: Queryable = db()): Promise<TripRow> {
  const at = now();
  const row = await one<TripRow>(`INSERT INTO trips (chat_id, title, created_at, updated_at) VALUES ($1, $2, $3, $3) RETURNING *`, [chatId, title, at], on);
  await q(`UPDATE chats SET focus_trip_id = $2 WHERE id = $1`, [chatId, row!.id], on);
  return row!;
}

export async function focusTrip(chatId: number, tripId: number, on: Queryable = db()): Promise<TripRow> {
  const row = await one<TripRow>(`SELECT * FROM trips WHERE id = $1 AND chat_id = $2`, [tripId, chatId], on);
  if (!row) throw new Error(`trip ${tripId} is not in chat ${chatId}`);
  await q(`UPDATE chats SET focus_trip_id = $2 WHERE id = $1`, [chatId, tripId], on);
  return row;
}

export async function tripsForChat(chatId: number, on: Queryable = db()): Promise<TripRow[]> {
  return q<TripRow>(`SELECT * FROM trips WHERE chat_id = $1 ORDER BY created_at, id`, [chatId], on);
}

export async function tripById(tripId: number, on: Queryable = db()): Promise<TripRow | undefined> {
  return one<TripRow>(`SELECT * FROM trips WHERE id = $1`, [tripId], on);
}

/** What the group calls the trip: its title, else the destination, else "trip N". */
export function tripName(trip: Pick<TripRow, "title" | "destination_name">, index?: number): string {
  return trip.title ?? trip.destination_name ?? (index !== undefined ? `trip ${index + 1}` : "the trip");
}

const JSON_COLUMNS = new Set<string>(["itinerary", "booking", "stages", "destination_place", "stay"]);

export async function updateTrip(tripId: number, patch: Partial<Omit<TripRow, "id" | "chat_id" | "public_id" | "created_at">>, on: Queryable = db()): Promise<TripRow> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return (await one<TripRow>(`SELECT * FROM trips WHERE id = $1`, [tripId], on))!;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const values = keys.map((k) => (JSON_COLUMNS.has(k) && patch[k] !== null && patch[k] !== undefined ? JSON.stringify(patch[k]) : patch[k]));
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
