// What a trip page shows, built from the local database. The page is public to anyone with the
// link, so this is the privacy boundary: first names only (never handles or phone numbers),
// no budgets or balances (the trip fund shows first names and contributions only), and only
// group chats.
import { one, q } from "../db/pool.ts";
import { activeMembers, labelOf, type ChatRow } from "../db/repos/core.ts";
import { formatUsd } from "../money/cents.ts";
import type { StoredOption } from "../agent/features/proposals.ts";
import type { PollRow } from "../trips/pollStore.ts";
import { STAGES, stagesOf } from "../trips/stages.ts";
import { tripName, tripsForChat, type TripRow } from "../trips/state.ts";
import { siteFund, siteStay } from "./fund.ts";
import type { SiteMessage, SiteOverview, SiteResearch, SiteStage, SiteTrip } from "./types.ts";

/** Message kinds that read as chat lines (membership changes, reactions and votes don't). */
const SHOWN_KINDS = ["text", "poll", "link"];
const MESSAGE_BATCH = 500;

export interface Snapshot {
  trip: SiteTrip;
  research: SiteResearch[];
  /** Messages after the trip's sync cursor, oldest first. */
  messages: SiteMessage[];
}

export const firstName = (label: string) => {
  const first = label.trim().split(/\s+/)[0] ?? "";
  return first.startsWith("…") ? "someone" : first.charAt(0).toUpperCase() + first.slice(1);
};

export async function buildSnapshot(trip: TripRow, chat: ChatRow, opts: { agentName: string; version: number }): Promise<Snapshot> {
  const members = await activeMembers(chat.id);
  const travelers = members.map((m) => firstName(labelOf(m)));
  const siblings = await tripsForChat(chat.id);
  const index = siblings.findIndex((t) => t.id === trip.id);
  return {
    trip: {
      id: trip.public_id,
      chatId: chat.public_id,
      title: titleOf(trip, index),
      summary: trip.summary,
      destination: trip.destination_name,
      startDate: trip.start_date,
      endDate: trip.end_date,
      status: trip.status,
      travelers,
      timezone: chat.timezone,
      overview: await overviewOf(trip, members.length),
      itinerary: trip.itinerary.map((d) => ({
        date: d.date,
        title: d.title,
        items: d.items.map((i) => ({
          name: i.name,
          setting: i.setting,
          cost: i.costCents > 0 ? `~${formatUsd(i.costCents)} pp` : undefined,
          time: i.time,
          notes: i.notes,
        })),
      })),
      version: opts.version,
    },
    research: await researchOf(trip.id),
    messages: await messagesAfter(trip, opts.agentName),
  };
}

function titleOf(trip: TripRow, index: number): string {
  const name = tripName(trip, index >= 0 ? index : undefined);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

async function overviewOf(trip: TripRow, groupSize: number): Promise<SiteOverview> {
  const proposal = await one<{ options: StoredOption[] }>(`SELECT options FROM proposals WHERE trip_id = $1 ORDER BY id DESC LIMIT 1`, [trip.id]);
  const poll = await one<PollRow>(`SELECT * FROM polls WHERE trip_id = $1 AND kind = 'destination' ORDER BY id DESC LIMIT 1`, [trip.id]);
  const counts = poll ? await voteCounts(poll.id) : new Map<number, number>();
  const options = (proposal?.options ?? []).map((o) => {
    const idx = poll?.options.findIndex((p) => p.ref === o.destId) ?? -1;
    return {
      name: o.name,
      perPerson: `${formatUsd(o.avgCents)}${o.live ? "" : " (est.)"}`,
      why: o.reasons.slice(0, 2).join(", ").toLowerCase() || undefined,
      votes: idx >= 0 ? (counts.get(idx) ?? 0) : undefined,
    };
  });
  let decision: string | undefined;
  if (poll?.status === "closed" && poll.winner_idx !== null) {
    const winner = poll.options[poll.winner_idx]?.title.split(" (")[0];
    if (winner) decision = `${winner} won the vote (${counts.get(poll.winner_idx) ?? 0} of ${groupSize}).`;
  }
  const fund = await siteFund(trip);
  const stay = siteStay(trip);
  return { stage: stageOf(trip, options.length), options, decision, booking: trip.booking ?? [], stages: stagesFor(trip), ...(fund ? { fund } : {}), ...(stay ? { stay } : {}) };
}

const STAGE_TITLE: Record<SiteStage["key"], string> = {
  location: "Location",
  dates: "Dates",
  travel: "Travel",
  stay: "Stay",
  food_activities: "Food & activities",
};

/** The stage progress bar: no money, no names. */
export function stagesFor(trip: TripRow): SiteStage[] {
  const map = stagesOf(trip);
  const fmt = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const detail: Partial<Record<SiteStage["key"], string>> = {
    location: map.location === "decided" ? (trip.destination_name ?? undefined) : undefined,
    dates: map.dates === "decided" && trip.start_date && trip.end_date ? `${fmt(trip.start_date)} – ${fmt(trip.end_date)}` : undefined,
    stay: map.stay === "decided" && trip.stay?.name ? trip.stay.name : undefined,
  };
  return STAGES.map((key) => ({ key, label: STAGE_TITLE[key], status: map[key], ...(detail[key] ? { detail: detail[key] } : {}) }));
}

function stageOf(trip: TripRow, optionCount: number): string {
  const where = trip.destination_name;
  switch (trip.status) {
    case "planning":
      return "Still gathering everyone's dates and home cities.";
    case "voting":
      return `Voting on ${optionCount || "a few"} options.`;
    case "locked":
      return where ? `Locked in: ${where}.` : "Destination locked in.";
    case "ongoing":
      return where ? `Happening now in ${where}.` : "Happening now.";
    case "settling":
      return "Back home, settling up.";
    case "done":
      return "All done.";
  }
}

async function voteCounts(pollId: number): Promise<Map<number, number>> {
  const rows = await q<{ option_idx: number; n: number }>(
    `SELECT option_idx, count(*)::int AS n FROM votes WHERE poll_id = $1 AND selected GROUP BY option_idx`,
    [pollId],
  );
  return new Map(rows.map((r) => [r.option_idx, r.n]));
}

async function researchOf(tripId: number): Promise<SiteResearch[]> {
  const rows = await q<{ topic: string; summary: string; body_md: string; sources: { title: string; url: string }[]; created_at: Date }>(
    `SELECT topic, summary, body_md, sources, created_at FROM trip_research WHERE trip_id = $1 ORDER BY created_at, id`,
    [tripId],
  );
  return rows.map((r) => ({ topic: r.topic, summary: r.summary, bodyMd: r.body_md, sources: r.sources, createdAt: r.created_at.toISOString() }));
}

async function messagesAfter(trip: TripRow, agentName: string): Promise<SiteMessage[]> {
  const rows = await q<{ id: number; person_id: number | null; text: string; sent_at: Date; display_name: string | null; handle: string | null }>(
    `SELECT m.id, m.person_id, m.text, m.sent_at, p.display_name, p.handle
     FROM messages m LEFT JOIN people p ON p.id = m.person_id
     WHERE m.trip_id = $1 AND m.id > $2 AND m.kind = ANY($3) AND m.text <> ''
     ORDER BY m.id LIMIT $4`,
    [trip.id, trip.site_message_cursor, SHOWN_KINDS, MESSAGE_BATCH],
  );
  return rows.map((r) => ({
    localId: r.id,
    sender: r.person_id === null ? agentName : firstName(labelOf(r)),
    fromAtlas: r.person_id === null,
    text: r.text,
    sentAt: r.sent_at.toISOString(),
  }));
}
