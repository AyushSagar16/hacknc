// Server-only reads from Supabase. RLS has no policies, so only this service-role client can
// read; it never reaches the browser. Every lookup is by UUID: there is no way to list trips.
import "server-only";
import { cache } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SiteDay, SiteOverview, SiteResearch, SiteTrip } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let client: SupabaseClient | undefined;
function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

interface TripRow {
  id: string;
  chat_id: string;
  title: string;
  summary: string | null;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  travelers: string[];
  timezone: string | null;
  overview: SiteOverview;
  itinerary: SiteDay[];
  version: number;
}

const toTrip = (r: TripRow): SiteTrip => ({
  id: r.id,
  chatId: r.chat_id,
  title: r.title,
  summary: r.summary ?? null,
  destination: r.destination,
  startDate: r.start_date,
  endDate: r.end_date,
  status: r.status,
  travelers: r.travelers ?? [],
  timezone: r.timezone ?? "America/New_York",
  overview: { ...r.overview, stage: r.overview?.stage ?? "", options: r.overview?.options ?? [], booking: r.overview?.booking ?? [] },
  itinerary: r.itinerary ?? [],
  version: r.version,
});

// Local preview without Supabase: `ATLAS_SITE_FIXTURES=1 npm run dev`. Never in production.
const useFixtures = process.env.NODE_ENV !== "production" && process.env.ATLAS_SITE_FIXTURES === "1";
const fixtures = () => import("./fixtures");

export const getTrip = cache(async (id: string): Promise<SiteTrip | null> => {
  if (!UUID.test(id)) return null;
  if (useFixtures) return (await fixtures()).FIXTURE_TRIPS.find((t) => t.id === id) ?? null;
  const { data, error } = await db().from("site_trips").select("*").eq("id", id).maybeSingle<TripRow>();
  if (error) throw new Error(`site_trips: ${error.message}`);
  return data ? toTrip(data) : null;
});

export interface TripLink {
  id: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  status: string;
}

export const getChatTrips = cache(async (chatId: string): Promise<TripLink[]> => {
  if (!UUID.test(chatId)) return [];
  if (useFixtures) {
    return (await fixtures()).FIXTURE_TRIPS.filter((t) => t.chatId === chatId).map((t) => ({ id: t.id, title: t.title, startDate: t.startDate, endDate: t.endDate, status: t.status }));
  }
  const { data, error } = await db()
    .from("site_trips")
    .select("id, title, start_date, end_date, status")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`site_trips: ${error.message}`);
  return (data ?? []).map((r) => ({ id: r.id, title: r.title, startDate: r.start_date, endDate: r.end_date, status: r.status }));
});

export const getResearch = cache(async (tripId: string): Promise<SiteResearch[]> => {
  if (useFixtures) return tripId === (await fixtures()).FIXTURE_TRIP_ID ? (await fixtures()).FIXTURE_RESEARCH : [];
  const { data, error } = await db().from("site_research").select("*").eq("trip_id", tripId).order("created_at", { ascending: true });
  if (error) throw new Error(`site_research: ${error.message}`);
  return (data ?? []).map((r) => ({ topic: r.topic, summary: r.summary, bodyMd: r.body_md, createdAt: r.created_at }));
});
