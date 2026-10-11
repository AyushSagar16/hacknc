// Publishing a trip page: snapshot the trip from Postgres, upsert it to the site store, then
// (when announcing) link it in the chat. The link goes out only after the page is written,
// because iMessage fetches the preview the moment the link lands.
import type { Config } from "../config.ts";
import { one } from "../db/pool.ts";
import { enqueueJob } from "../pipeline/jobs.ts";
import { now } from "../clock.ts";
import type { ChatRow } from "../db/repos/core.ts";
import type { Action } from "../transport/outbound.ts";
import { tripById, type TripRow } from "../trips/state.ts";
import { buildSnapshot } from "./snapshot.ts";
import { siteFor } from "./store.ts";
import type { SiteSection } from "./types.ts";

export const SYNC_JOB = "site.sync";
export const ANNOUNCE_JOB = "site.announce";
/** Let the turn's own replies reach the outbox before a silent sync copies the chat. */
const SYNC_DELAY_MS = 4_000;

/** `?v=` changes on every publish: iMessage caches a link's preview by URL. */
export function pageUrl(baseUrl: string, tripPublicId: string, section: SiteSection, version?: number): string {
  const path = section === "overview" ? "" : `/${section}`;
  return `${baseUrl}/t/${tripPublicId}${path}${version !== undefined ? `?v=${version}` : ""}`;
}

export function hubUrl(baseUrl: string, chatPublicId: string): string {
  return `${baseUrl}/g/${chatPublicId}`;
}

const FALLBACK: Record<SiteSection, string> = {
  overview: "trip page",
  itinerary: "full itinerary",
  chat: "chat log",
};

export function linkAction(url: string, section: SiteSection): Action {
  return { type: "link", url, fallbackText: FALLBACK[section] };
}

export interface Published {
  version: number;
  url: string;
}

/**
 * Write the trip's page. Returns null when trip pages are off or the chat isn't a group chat
 * (DMs carry private budgets). Throws if the store write fails.
 */
export async function publishTrip(cfg: Config, tripId: number, chat: ChatRow, section: SiteSection = "overview", opts: { privateChat?: boolean } = {}): Promise<Published | null> {
  const site = siteFor(cfg);
  // A private chat is published only when its person asked for the page, and only the trip itself:
  // the one-on-one conversation (budgets, balances) is never copied to the page.
  if (!site || (!chat.is_group && !opts.privateChat)) return null;
  const bumped = await one<{ site_version: number }>(`UPDATE trips SET site_version = site_version + 1 WHERE id = $1 RETURNING site_version`, [tripId]);
  const trip = await tripById(tripId);
  if (!bumped || !trip) return null;
  const snap = await buildSnapshot(trip, chat, { agentName: cfg.AGENT_NAME, version: bumped.site_version });
  await site.store.upsertTrip(snap.trip);
  await site.store.upsertResearch(snap.trip.id, snap.research);
  if (chat.is_group && snap.messages.length) {
    await site.store.upsertMessages(snap.trip.id, snap.messages);
    const last = snap.messages.at(-1)!.localId;
    await one(`UPDATE trips SET site_message_cursor = GREATEST(site_message_cursor, $2) WHERE id = $1`, [tripId, last]);
  }
  return { version: bumped.site_version, url: pageUrl(site.baseUrl, trip.public_id, section, bumped.site_version) };
}

/** Copy new chat lines and state to the page soon, without posting anything. */
export async function requestSync(cfg: Config, trip: Pick<TripRow, "id">): Promise<void> {
  if (!siteFor(cfg)) return;
  await enqueueJob(SYNC_JOB, { tripId: trip.id }, { dueAt: new Date(now().getTime() + SYNC_DELAY_MS), singletonKey: `site:sync:${trip.id}` });
}

/** Publish and post the section's link from a background job (retried until the store takes it). */
export async function requestAnnounce(cfg: Config, trip: Pick<TripRow, "id">, section: SiteSection, opts: { privateChat?: boolean } = {}): Promise<void> {
  if (!siteFor(cfg)) return;
  await enqueueJob(ANNOUNCE_JOB, { tripId: trip.id, section, ...(opts.privateChat ? { privateChat: true } : {}) }, { singletonKey: `site:announce:${trip.id}:${section}` });
}
