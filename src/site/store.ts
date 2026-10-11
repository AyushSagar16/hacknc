// Where trip pages are published. Supabase in production (the site reads the same tables);
// an in-memory store for tests and the simulator. Every write is an idempotent upsert, so a
// retried or overlapping publish is harmless.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "../config.ts";
import type { SiteMessage, SiteResearch, SiteTrip } from "./types.ts";

export interface SiteStore {
  upsertTrip(trip: SiteTrip): Promise<void>;
  upsertResearch(tripId: string, notes: SiteResearch[]): Promise<void>;
  upsertMessages(tripId: string, messages: SiteMessage[]): Promise<void>;
}

const TIMEOUT_MS = 8_000;

export class SupabaseSiteStore implements SiteStore {
  private readonly db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }) },
    });
  }

  async upsertTrip(t: SiteTrip): Promise<void> {
    await check("site_chats", this.db.from("site_chats").upsert({ id: t.chatId }, { onConflict: "id", ignoreDuplicates: true }));
    await check(
      "site_trips",
      this.db.from("site_trips").upsert({
        id: t.id,
        chat_id: t.chatId,
        title: t.title,
        summary: t.summary,
        destination: t.destination,
        start_date: t.startDate,
        end_date: t.endDate,
        status: t.status,
        travelers: t.travelers,
        timezone: t.timezone,
        overview: t.overview,
        itinerary: t.itinerary,
        version: t.version,
        updated_at: new Date().toISOString(),
      }),
    );
  }

  async upsertResearch(tripId: string, notes: SiteResearch[]): Promise<void> {
    if (!notes.length) return;
    await check(
      "site_research",
      this.db.from("site_research").upsert(
        notes.map((n) => ({ trip_id: tripId, topic: n.topic, summary: n.summary, body_md: n.bodyMd, sources: n.sources, created_at: n.createdAt })),
        { onConflict: "trip_id,topic" },
      ),
    );
  }

  async upsertMessages(tripId: string, messages: SiteMessage[]): Promise<void> {
    if (!messages.length) return;
    await check(
      "site_messages",
      this.db.from("site_messages").upsert(
        messages.map((m) => ({ trip_id: tripId, local_id: m.localId, sender: m.sender, from_atlas: m.fromAtlas, text: m.text, sent_at: m.sentAt })),
        { onConflict: "trip_id,local_id" },
      ),
    );
  }
}

async function check(table: string, req: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await req;
  if (error) throw new Error(`supabase ${table}: ${error.message}`);
}

export class MemorySiteStore implements SiteStore {
  readonly trips = new Map<string, SiteTrip>();
  readonly research = new Map<string, Map<string, SiteResearch>>();
  readonly messages = new Map<string, Map<number, SiteMessage>>();

  async upsertTrip(t: SiteTrip): Promise<void> {
    this.trips.set(t.id, structuredClone(t));
  }
  async upsertResearch(tripId: string, notes: SiteResearch[]): Promise<void> {
    const m = this.research.get(tripId) ?? new Map();
    for (const n of notes) m.set(n.topic, n);
    this.research.set(tripId, m);
  }
  async upsertMessages(tripId: string, messages: SiteMessage[]): Promise<void> {
    const m = this.messages.get(tripId) ?? new Map();
    for (const msg of messages) m.set(msg.localId, msg);
    this.messages.set(tripId, m);
  }
}

export interface Site {
  store: SiteStore;
  /** Origin of the web app, no trailing slash. */
  baseUrl: string;
}

let override: Site | null | undefined;
let fromConfig: { key: string; site: Site | null } | undefined;

/** Trip pages are on when Supabase and the site URL are configured (or a test installed a store). */
export function siteFor(cfg: Config | undefined): Site | null {
  if (override !== undefined) return override;
  if (!cfg) return null;
  const key = `${cfg.SUPABASE_URL}|${cfg.SITE_BASE_URL}`;
  if (fromConfig?.key !== key) {
    const on = cfg.SUPABASE_URL && cfg.SUPABASE_SERVICE_ROLE_KEY && cfg.SITE_BASE_URL;
    fromConfig = { key, site: on ? { store: new SupabaseSiteStore(cfg.SUPABASE_URL!, cfg.SUPABASE_SERVICE_ROLE_KEY!), baseUrl: cfg.SITE_BASE_URL! } : null };
  }
  return fromConfig.site;
}

/** Tests and the simulator: publish somewhere else (null turns trip pages off; undefined resets). */
export function useSite(site: Site | null | undefined): void {
  override = site;
}
