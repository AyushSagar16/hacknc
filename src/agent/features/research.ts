// Web research for a trip: one Google-Search-grounded Gemini call per topic, saved with its
// sources and published to the trip page. It runs as a background job (a grounded call takes
// longer than a turn may), then posts a short summary and the research link. Each topic is
// researched once per trip unless someone asks for it again.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isoDate, now } from "../../clock.ts";
import { childLog } from "../../log.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, labelOf } from "../../db/repos/core.ts";
import { enqueueJob } from "../../pipeline/jobs.ts";
import { profilesFor } from "../../profile/store.ts";
import { groupView } from "../../profile/groupView.ts";
import { tripById, type TripRow } from "../../trips/state.ts";
import type { Config } from "../../config.ts";
import type { Llm } from "../llm.ts";
import type { Action } from "../../transport/outbound.ts";
import type { Feature, TurnCtx } from "../feature.ts";
import { ToolError, strList, type Tool } from "../tools.ts";
import { formatRange } from "./planning.ts";
import { announceFromJob } from "./site.ts";

const PROMPT = readFileSync(fileURLToPath(new URL("../prompts/research.md", import.meta.url)), "utf8");
const log = childLog({ component: "research" });

export const RESEARCH_JOB = "research.run";
const MAX_TOPICS = 5;
const CALL_TIMEOUT_MS = 45_000;

/** What a locked trip gets without anyone asking. */
export const DEFAULT_TOPICS = ["Getting there & entry", "Weather & packing", "Where to stay", "Food", "Local tips"];

export interface ResearchNote {
  topic: string;
  summary: string;
  bodyMd: string;
  sources: { title: string; url: string }[];
}

const topicKey = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
const tidyTopic = (t: string) => {
  const s = t.trim().replace(/\s+/g, " ").slice(0, 60);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Split the model's answer into the SUMMARY line and the note. */
export function parseNote(text: string): { summary: string; bodyMd: string } | null {
  const trimmed = text.trim().replace(/^```(?:markdown)?\s*|\s*```$/g, "");
  const m = /^\s*\**SUMMARY:?\**\s*(.+?)\s*(?:\n|$)([\s\S]*)$/i.exec(trimmed);
  const summary = (m ? m[1]! : trimmed.split("\n")[0]!).replace(/\*+/g, "").trim();
  const bodyMd = (m ? m[2]! : trimmed.split("\n").slice(1).join("\n")).trim();
  if (summary.length < 8 || bodyMd.length < 40) return null;
  return { summary: summary.slice(0, 240), bodyMd: bodyMd.slice(0, 4_000) };
}

async function existingTopics(tripId: number): Promise<Set<string>> {
  const rows = await q<{ topic: string }>(`SELECT topic FROM trip_research WHERE trip_id = $1`, [tripId]);
  return new Set(rows.map((r) => topicKey(r.topic)));
}

/** Queue research for a trip; topics already researched are skipped unless `force`. */
export async function queueResearch(trip: Pick<TripRow, "id">, topics: string[], opts: { force?: boolean; announce?: boolean } = {}): Promise<string[]> {
  const done = opts.force ? new Set<string>() : await existingTopics(trip.id);
  const todo = [...new Map(topics.map((t) => [topicKey(t), tidyTopic(t)])).entries()].filter(([k]) => k && !done.has(k)).map(([, t]) => t).slice(0, MAX_TOPICS);
  if (!todo.length) return [];
  const hash = createHash("sha1").update(todo.map(topicKey).join("|")).digest("hex").slice(0, 10);
  await enqueueJob(RESEARCH_JOB, { tripId: trip.id, topics: todo, force: opts.force === true, announce: opts.announce !== false }, { singletonKey: `research:${trip.id}:${hash}`, maxAttempts: 3 });
  return todo;
}

/** The trip as the researcher should picture it: where, when, who, from where, what they eat. */
async function tripBrief(trip: TripRow, timezone: string): Promise<string> {
  const members = await activeMembers(trip.chat_id);
  const profiles = await profilesFor(members.map((m) => m.id), { tripId: trip.id });
  const view = groupView(
    members.map((m) => ({ personId: m.id, label: labelOf(m), profile: profiles.get(m.id)! })),
    isoDate(now(), timezone),
  );
  const homes = [...new Set(view.members.map((m) => m.profile.homeCity?.value).filter((h): h is string => Boolean(h)))];
  const diets = [...view.dietary.keys()].map((d) => d.replace(/_/g, " "));
  return [
    `destination: ${trip.destination_name ?? trip.title ?? "not chosen yet"}`,
    `dates: ${trip.start_date && trip.end_date ? `${formatRange(trip.start_date, trip.end_date)} (${trip.start_date} to ${trip.end_date})` : "not set yet"}`,
    `group: ${members.length} friends${homes.length ? `, leaving from ${homes.join(", ")}` : ""}`,
    diets.length ? `dietary needs in the group: ${diets.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function researchTopic(llm: Llm, cfg: Config, brief: string, topic: string, trace?: { chatId?: number }): Promise<ResearchNote | null> {
  const result = await llm.generate({
    role: "research",
    model: cfg.GEMINI_MODEL_RESEARCH ?? cfg.GEMINI_MODEL_AGENT,
    system: PROMPT,
    contents: [{ role: "user", parts: [{ text: `${brief}\n\ntopic: ${topic}` }] }],
    grounding: "google_search",
    temperature: 0.3,
    timeoutMs: CALL_TIMEOUT_MS,
    maxOutputTokens: 1_500,
    trace,
  });
  const note = parseNote(result.text);
  if (!note) return null;
  return { topic, ...note, sources: (result.sources ?? []).slice(0, 8) };
}

async function saveNote(tripId: number, n: ResearchNote, model: string): Promise<void> {
  await q(
    `INSERT INTO trip_research (trip_id, topic, summary, body_md, sources, model, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (trip_id, topic) DO UPDATE SET summary = EXCLUDED.summary, body_md = EXCLUDED.body_md, sources = EXCLUDED.sources, model = EXCLUDED.model, created_at = EXCLUDED.created_at`,
    [tripId, n.topic, n.summary, n.bodyMd, JSON.stringify(n.sources), model, now()],
  );
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** The chat version: one line per topic. The page has the rest. */
export function chatSummary(place: string, notes: ResearchNote[]): string {
  return [`did some digging on ${place.toLowerCase()}:`, ...notes.map((n) => `${lower(n.topic)}: ${clip(lower(n.summary.replace(/\.$/, "")), 110)}`)].join("\n");
}

const researchTool: Tool = {
  decl: {
    name: "research_trip",
    description:
      "Look things up on the web for this trip (visas and entry rules, weather and packing, neighborhoods to stay in, food, transit, events, safety...) and put sourced notes on the trip page. Runs in the background and posts a summary and link when done. Use when someone asks a question that needs current facts about the destination.",
    parameters: {
      type: "object",
      properties: { topics: { type: "array", items: { type: "string" }, description: "1 to 5 short topics, e.g. [\"visas\", \"vegetarian food\"]" } },
      required: ["topics"],
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    if (!tc.trip.destination_name && !tc.trip.title) throw new ToolError("there's no destination yet; research needs a place");
    const topics = strList(args.topics);
    if (!topics.length) throw new ToolError("give 1 to 5 topics");
    const queued = await queueResearch(tc.trip, topics, { force: true });
    return {
      ok: true,
      data: { researching: queued },
      next: "research is running in the background and will post when done; say in one short line that you're looking into it",
    };
  },
};

export const researchFeature: Feature = {
  name: "research",
  tools: [researchTool],

  async situation(tc) {
    const rows = await q<{ topic: string; summary: string }>(`SELECT topic, summary FROM trip_research WHERE trip_id = $1 ORDER BY created_at`, [tc.trip.id]);
    const pending = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE kind = $1 AND done_at IS NULL AND failed_at IS NULL AND (payload->>'tripId')::bigint = $2`,
      [RESEARCH_JOB, tc.trip.id],
    );
    if (!rows.length && !pending?.n) return null;
    return {
      title: "research (on the trip page)",
      lines: [...rows.map((r) => `- ${r.topic}: ${r.summary}`), ...(pending?.n ? ["more research is running in the background"] : [])],
    };
  },

  async onTripLocked(trip) {
    await queueResearch(trip, DEFAULT_TOPICS);
  },

  jobs(svc) {
    return {
      [RESEARCH_JOB]: async (payload, { jobId }) => {
        const trip = await tripById(Number(payload.tripId));
        if (!trip) return;
        const chat = await one<{ timezone: string }>(`SELECT timezone FROM chats WHERE id = $1`, [trip.chat_id]);
        const brief = await tripBrief(trip, chat?.timezone ?? svc.cfg.DEFAULT_TIMEZONE);
        const topics = (Array.isArray(payload.topics) ? payload.topics : []).filter((t): t is string => typeof t === "string");
        const skip = payload.force === true ? new Set<string>() : await existingTopics(trip.id);
        const notes: ResearchNote[] = [];
        let failures = 0;
        for (const topic of topics) {
          if (skip.has(topicKey(topic))) continue;
          try {
            const note = await researchTopic(svc.llm, svc.cfg, brief, topic, { chatId: trip.chat_id });
            if (!note) {
              failures += 1;
              continue;
            }
            await saveNote(trip.id, note, svc.cfg.GEMINI_MODEL_RESEARCH ?? svc.cfg.GEMINI_MODEL_AGENT);
            notes.push(note);
          } catch (err) {
            failures += 1;
            log.warn({ err: (err as Error).message, tripId: trip.id, topic }, "research call failed");
          }
        }
        // Nothing came back: let the job retry (the topics done so far are skipped next time).
        if (!notes.length && failures) throw new Error(`research failed for all ${failures} topic(s)`);
        if (!notes.length || payload.announce === false) return;
        const place = trip.destination_name ?? trip.title ?? "the trip";
        await svc.post(trip.chat_id, `research${jobId}`, [{ type: "say", text: chatSummary(place, notes) } satisfies Action]);
        await announceFromJob(svc, trip.id, "research", `research${jobId}:link`);
      },
    };
  },
};
