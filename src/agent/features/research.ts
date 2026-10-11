// Research on the trip page. It all comes from the web search in features/search.ts (keyless
// results + pages read, every item checked against the page it came from):
//   - when a trip locks in, a background job looks up things to do, food and events on the trip
//     dates, saves each as a note with its source, posts a one-line-per-topic summary and links
//     the research section;
//   - every web_search Atlas runs for a trip during the chat is saved to the page as well.
import { createHash } from "node:crypto";
import { isoDate, now } from "../../clock.ts";
import { childLog } from "../../log.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, labelOf } from "../../db/repos/core.ts";
import { enqueueJob } from "../../pipeline/jobs.ts";
import { profilesFor } from "../../profile/store.ts";
import { groupView } from "../../profile/groupView.ts";
import { rangeLabel, stripArtifacts } from "../../search/format.ts";
import { tripById, type TripRow } from "../../trips/state.ts";
import type { AppServices, Feature } from "../feature.ts";
import { lookup as webLookup, type Lookup, type LookupInput, type Purpose } from "./search.ts";
import { requestSync } from "../../site/publish.ts";
import { announceFromJob } from "./site.ts";

const log = childLog({ component: "research" });

export const RESEARCH_JOB = "research.run";
/** Background lookups can take longer than a chat reply's search budget. */
const LOOKUP_TIMEOUT_MS = 30_000;

/** What a locked trip gets without anyone asking: one web lookup per topic. */
export const DEFAULT_TOPICS: { topic: string; purpose: Purpose; query: (place: string, month: string) => string }[] = [
  { topic: "Things to do", purpose: "things_to_do", query: (p, m) => `things to do in ${p} in ${m}` },
  { topic: "Food", purpose: "food", query: (p) => `best places to eat in ${p}` },
  { topic: "Events during the trip", purpose: "events", query: (p, m) => `events and festivals in ${p} in ${m}` },
];

export interface ResearchNote {
  topic: string;
  summary: string;
  bodyMd: string;
  sources: { title: string; url: string }[];
}

// ---------- seam (tests) ----------

type LookupFn = (input: LookupInput, svc: Pick<AppServices, "llm" | "cfg">) => Promise<Lookup>;
let lookupFn: LookupFn = (input, svc) => webLookup(svc.llm, svc.cfg, input, LOOKUP_TIMEOUT_MS);
/** Tests replace the web lookup; undefined restores it. */
export function setResearchLookup(fn: LookupFn | undefined): void {
  lookupFn = fn ?? ((input, svc) => webLookup(svc.llm, svc.cfg, input, LOOKUP_TIMEOUT_MS));
}

// ---------- notes ----------

const topicKey = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** A lookup as a page note: lists become bullets, facts a short paragraph; dates aren't research. */
export function noteFromLookup(topic: string, found: Lookup): ResearchNote | null {
  const sources = found.source ? [{ title: hostOf(found.source), url: found.source }] : [];
  if (found.kind === "list") {
    const items = found.items.map((i) => ({ ...i, name: stripArtifacts(i.name), detail: i.detail ? stripArtifacts(i.detail) : undefined }));
    if (!items.length) return null;
    const lines = items.map((i) => {
      const when = i.start ? `${rangeLabel(i.start, i.end)}: ` : "";
      return `- **${capitalize(i.name)}**${i.detail || when ? `: ${when}${i.detail ?? ""}` : ""}`;
    });
    const top = items.slice(0, 3).map((i) => i.name.toLowerCase());
    const summary = found.noEvents ? `No dated events found for the trip; always-on picks: ${top.join(", ")}.` : `Top picks: ${top.join(", ")}.`;
    return { topic: capitalize(topic.slice(0, 60)), summary, bodyMd: lines.join("\n"), sources };
  }
  if (found.kind === "facts") {
    const answer = stripArtifacts(found.answer);
    if (answer.length < 8) return null;
    return { topic: capitalize(topic.slice(0, 60)), summary: capitalize(answer.split(/(?<=[.!?])\s/)[0]!.slice(0, 240)), bodyMd: capitalize(answer), sources };
  }
  return null;
}

export async function saveNote(tripId: number, n: ResearchNote): Promise<void> {
  await q(
    `INSERT INTO trip_research (trip_id, topic, summary, body_md, sources, model, created_at) VALUES ($1,$2,$3,$4,$5,'web_search',$6)
     ON CONFLICT (trip_id, topic) DO UPDATE SET summary = EXCLUDED.summary, body_md = EXCLUDED.body_md, sources = EXCLUDED.sources, created_at = EXCLUDED.created_at`,
    [tripId, n.topic, n.summary, n.bodyMd, JSON.stringify(n.sources), now()],
  );
}

/** web_search found something for this trip: keep it on the trip page too (never throws). */
export async function saveLookupToTrip(cfg: AppServices["cfg"], trip: Pick<TripRow, "id">, topic: string, found: Lookup): Promise<void> {
  try {
    const note = noteFromLookup(topic, found);
    if (!note) return;
    await saveNote(trip.id, note);
    await requestSync(cfg, trip);
  } catch (err) {
    log.warn({ err: (err as Error).message, tripId: trip.id }, "couldn't save a lookup to the trip page");
  }
}

async function existingTopics(tripId: number): Promise<Set<string>> {
  const rows = await q<{ topic: string }>(`SELECT topic FROM trip_research WHERE trip_id = $1`, [tripId]);
  return new Set(rows.map((r) => topicKey(r.topic)));
}

/** Queue the default research for a trip (topics already on the page are skipped). */
export async function queueResearch(trip: Pick<TripRow, "id">): Promise<void> {
  const hash = createHash("sha1").update(DEFAULT_TOPICS.map((t) => t.topic).join("|")).digest("hex").slice(0, 8);
  await enqueueJob(RESEARCH_JOB, { tripId: trip.id }, { singletonKey: `research:${trip.id}:${hash}`, maxAttempts: 3 });
}

/** The group as the search should picture it: who's going, from where, what they eat and like. */
async function context(trip: TripRow, timezone: string): Promise<string[]> {
  const members = await activeMembers(trip.chat_id);
  const profiles = await profilesFor(members.map((m) => m.id), { chatId: trip.chat_id, tripId: trip.id });
  const view = groupView(
    members.map((m) => ({ personId: m.id, label: labelOf(m), profile: profiles.get(m.id)! })),
    isoDate(now(), timezone),
  );
  const join = (names: string[]) => names.join(" and ");
  const lines = [`trip destination: ${trip.destination_name ?? trip.title}`];
  if (trip.start_date && trip.end_date) lines.push(`trip dates: ${trip.start_date} to ${trip.end_date}`);
  if (members.length > 1) lines.push(`a group of ${members.length} friends`);
  for (const [tag, who] of view.likes) lines.push(`${join(who)} like${who.length > 1 ? "" : "s"} ${tag}`);
  for (const [diet, who] of view.dietary) lines.push(`${join(who)}: ${diet}`);
  return lines.slice(0, 12);
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The chat version: one line per topic. The page has the rest. */
export function chatSummary(place: string, notes: ResearchNote[]): string {
  return [`did some digging on ${place.toLowerCase()} for the trip page:`, ...notes.map((n) => `${lower(n.topic)}: ${lower(n.summary.replace(/\.$/, ""))}`)].join("\n");
}

export const researchFeature: Feature = {
  name: "research",

  async situation(tc) {
    const rows = await q<{ topic: string; summary: string }>(`SELECT topic, summary FROM trip_research WHERE trip_id = $1 ORDER BY created_at`, [tc.trip.id]);
    const pending = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE kind = $1 AND done_at IS NULL AND failed_at IS NULL AND (payload->>'tripId')::bigint = $2`,
      [RESEARCH_JOB, tc.trip.id],
    );
    if (!rows.length && !pending?.n) return null;
    return {
      title: "research on the trip page",
      lines: [...rows.map((r) => `- ${r.topic}: ${r.summary}`), ...(pending?.n ? ["more research is running in the background"] : [])],
    };
  },

  async onTripLocked(trip) {
    if (trip.destination_name) await queueResearch(trip);
  },

  jobs(svc) {
    return {
      [RESEARCH_JOB]: async (payload, { jobId }) => {
        const trip = await tripById(Number(payload.tripId));
        if (!trip?.destination_name) return;
        const chat = await one<{ timezone: string }>(`SELECT timezone FROM chats WHERE id = $1`, [trip.chat_id]);
        const today = isoDate(now(), chat?.timezone ?? svc.cfg.DEFAULT_TIMEZONE);
        const lines = await context(trip, chat?.timezone ?? svc.cfg.DEFAULT_TIMEZONE);
        const month = new Date(`${trip.start_date ?? today}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase();
        const window = trip.start_date && trip.end_date ? { start: trip.start_date, end: trip.end_date } : undefined;
        const done = await existingTopics(trip.id);
        const notes: ResearchNote[] = [];
        let failures = 0;
        for (const t of DEFAULT_TOPICS) {
          if (done.has(topicKey(t.topic))) continue;
          try {
            const found = await lookupFn(
              { query: t.query(trip.destination_name.toLowerCase(), month), purpose: t.purpose, context: lines, today, place: trip.destination_name, ...(window ? { window } : {}), trace: { chatId: trip.chat_id } },
              svc,
            );
            const note = noteFromLookup(t.topic, found);
            if (!note) continue;
            await saveNote(trip.id, note);
            notes.push(note);
          } catch (err) {
            failures += 1;
            log.warn({ err: (err as Error).message, tripId: trip.id, topic: t.topic }, "research lookup failed");
          }
        }
        // Nothing came back: let the job retry (topics already saved are skipped next time).
        if (!notes.length && failures) throw new Error(`research failed for all ${failures} topic(s)`);
        if (!notes.length) return;
        await svc.post(trip.chat_id, `research${jobId}`, [{ type: "say", text: chatSummary(trip.destination_name, notes) }]);
        await announceFromJob(svc, trip.id, "research", `research${jobId}:link`);
      },
    };
  },
};
