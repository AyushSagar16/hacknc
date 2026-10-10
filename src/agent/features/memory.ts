// Long-term semantic memory (Tiger Data pgvector). After every turn a background job embeds the
// turn's messages and new facts; each agent turn recalls the most relevant older chunks into its
// situation ("what did leo say about lisbon?" three weeks later), and the agent can search on
// demand with recall_memory. History stays in its chat; a person's facts follow them across chats.
import type { Config } from "../../config.ts";
import { childLog } from "../../log.ts";
import { now } from "../../clock.ts";
import { one, q } from "../../db/pool.ts";
import { enqueueJob } from "../../pipeline/jobs.ts";
import { embedTurn, rememberDecision } from "../../memory/write.ts";
import { recall, warmRecall, type MemoryHit, type RecallInput } from "../../memory/retrieve.ts";
import type { Feature, TurnCtx } from "../feature.ts";
import { CassetteLlm, FakeLlm, NoKeyLlm, type Llm } from "../llm.ts";
import { str, type Tool, type ToolCtx } from "../tools.ts";
import { formatRange } from "./planning.ts";

export const MEMORY_EMBED_JOB = "memory.embed";
export const MEMORY_DECISION_JOB = "memory.decision";
export const MEMORY_SECTION_TITLE = "recalled from earlier chats (semantic memory)";
/** Messages this recent are part of the live conversation the agent already reads; don't recall them. */
export const FRESH_MS = 6 * 3_600_000;
/** How long the embed job waits for a still-running turn to finish sending before embedding anyway. */
const TURN_WAIT_MS = 2 * 60_000;
const EXCERPT_CHARS = 360;

const log = childLog({ component: "memory" });

/** What the agent is asking about: this batch's new texts, else the last few lines of the chat. */
export function memoryQuery(tc: Pick<TurnCtx, "batch" | "history" | "consumed" | "cfg">): string {
  const fresh = tc.batch.filter((m) => m.kind === "text" && m.direction === "inbound" && !tc.consumed.has(m.id) && m.text.trim());
  const source = fresh.length ? fresh : tc.history.filter((m) => m.kind === "text" && m.text.trim()).slice(-3);
  return cleanQuery(source.map((m) => m.text.trim()).join("\n"), tc.cfg.AGENT_NAME);
}

/** Drop the agent's own name (it's addressing, not content) and squeeze whitespace. */
export function cleanQuery(text: string, agentName: string): string {
  const name = agentName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (name ? text.replace(new RegExp(`@?\\b${name}\\b[,:]?`, "gi"), " ") : text).replace(/\s+/g, " ").trim().slice(0, 1_000);
}

const shortDay = (at: Date, timeZone: string, today: Date): string => {
  const sameYear = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(at) === new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(today);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone })
    .format(at)
    .toLowerCase()
    .replace(",", "");
};

const WORD_STOP = new Set(["the", "and", "for", "you", "what", "did", "about", "say", "said", "was", "are", "who", "how", "that", "this", "with"]);
const terms = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !WORD_STOP.has(w));

/** A window can be long; show the lines that share words with the query, flattened to one line. */
export function excerpt(content: string, query: string, max = EXCERPT_CHARS): string {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  let shown = lines.join(" / ");
  if (shown.length > max) {
    const want = new Set(terms(query));
    const picked = lines.filter((l) => terms(l).some((w) => want.has(w)));
    if (picked.length) shown = picked.join(" / ");
  }
  return shown.length <= max ? shown : `${shown.slice(0, max - 1)}…`;
}

/** Which embedder produced the vectors, for the trace row ("hash" for the deterministic test embedder). */
export function embedderName(llm: Llm, cfg: Config): string {
  if (llm instanceof FakeLlm || llm instanceof NoKeyLlm || llm instanceof CassetteLlm || !cfg.GEMINI_API_KEY) return "hash";
  return cfg.GEMINI_EMBED_MODEL;
}

function recallScope(ctx: ToolCtx): { isGroup: boolean; viewerId?: number } {
  return ctx.chat.is_group ? { isGroup: true } : { isGroup: false, viewerId: ctx.senderId ?? ctx.members[0]?.id };
}

async function trace(ctx: ToolCtx, query: string, hits: MemoryHit[], ms: number, error?: string): Promise<void> {
  const shown = hits
    .slice(0, 5)
    .map((h) => `${h.score.toFixed(2)} ${h.kind}: ${h.visibility === "private" ? "(private)" : h.content.replace(/\s+/g, " ").slice(0, 90)}`)
    .join(" | ");
  const reason = `query "${query.slice(0, 80)}" → ${shown || "no hits"}`.slice(0, 500);
  try {
    await q(`INSERT INTO llm_traces (role, model, chat_id, turn_id, latency_ms, decision, reason, error, created_at) VALUES ('memory', $1, $2, $3, $4, $5, $6, $7, $8)`, [
      embedderName(ctx.llm, ctx.cfg),
      ctx.chat.id,
      ctx.turnId,
      ms,
      String(hits.length),
      reason,
      error ?? null,
      now(),
    ]);
  } catch {
    // tracing is best-effort
  }
}

const recallMemory: Tool = {
  decl: {
    name: "recall_memory",
    description:
      "Search long-term memory: everything said in this chat before (including weeks ago, beyond the recent chat you can see) plus each member's saved preferences from any chat they're in. Use it when someone asks what was said or decided earlier, or what someone likes or ruled out. Returns dated snippets in people's own words; quote them, never guess.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "what to look for, in plain words (e.g. \"leo lisbon trip food\")" } },
      required: ["query"],
    },
  },
  async run(args, ctx) {
    const query = cleanQuery(str(args.query) ?? "", ctx.cfg.AGENT_NAME);
    if (!query) return { ok: false, error: "query is required" };
    const t0 = Date.now();
    let hits: MemoryHit[];
    try {
      hits = await recall({ llm: ctx.llm, chatId: ctx.chat.id, memberIds: ctx.members.map((m) => m.id), query, ...recallScope(ctx), now: ctx.now });
    } catch (err) {
      log.warn({ chatId: ctx.chat.id, err: (err as Error).message }, "recall_memory failed");
      await trace(ctx, query, [], Date.now() - t0, (err as Error).message);
      return { ok: false, error: "memory search is unavailable right now" };
    }
    await trace(ctx, query, hits, Date.now() - t0);
    return {
      ok: true,
      data: { hits: hits.map((h) => ({ when: shortDay(h.createdAt, ctx.chat.timezone, ctx.now), kind: h.kind, content: h.content, score: Math.round(h.score * 100) / 100 })) },
      next: hits.length ? "answer from these snippets; say roughly when it was said if that helps" : "nothing in memory matches; say you don't remember rather than guessing",
    };
  },
};

/** The recall the situation section runs for this turn, or undefined when there's nothing to ask. */
function situationRecall(tc: TurnCtx): RecallInput | undefined {
  const query = memoryQuery(tc);
  if (!query) return undefined;
  const cutoff = tc.now.getTime() - FRESH_MS;
  const excludeMessageIds = tc.history.filter((h) => h.sent_at.getTime() >= cutoff).map((h) => h.id);
  return { llm: tc.llm, chatId: tc.chat.id, memberIds: tc.members.map((m) => m.id), query, ...recallScope(tc), excludeMessageIds, now: tc.now };
}

/** Start this turn's recall early (the brain calls it once it knows Atlas will answer). */
export function warmMemory(tc: TurnCtx): void {
  const input = situationRecall(tc);
  if (input) warmRecall(input);
}

export const memoryFeature: Feature = {
  name: "memory",
  tools: [recallMemory],

  async situation(tc) {
    // A feature list may name memory twice (default + extraFeatures); recall once per turn.
    if (tc.notes.has("memory.situation")) return null;
    tc.notes.set("memory.situation", true);
    const input = situationRecall(tc);
    if (!input) return null;
    const query = input.query;
    const t0 = Date.now();
    let hits: MemoryHit[];
    try {
      hits = await recall(input);
    } catch (err) {
      log.warn({ chatId: tc.chat.id, err: (err as Error).message }, "memory recall failed; continuing without it");
      await trace(tc, query, [], Date.now() - t0, (err as Error).message);
      return null;
    }
    await trace(tc, query, hits, Date.now() - t0);
    if (hits.length === 0) return null;
    return {
      title: MEMORY_SECTION_TITLE,
      lines: hits.map((h) => `(${shortDay(h.createdAt, tc.chat.timezone, tc.now)}, ${h.kind}) ${excerpt(h.content, query)}`),
    };
  },

  async afterTurn(tc) {
    try {
      if (tc.notes.has("memory.queued")) return;
      tc.notes.set("memory.queued", true);
      const messageIds = tc.batch.filter((m) => m.kind === "text").map((m) => m.id);
      // Atlas's own lines are sent after the brain returns; the job picks them up by turn id.
      if (messageIds.length === 0 && !tc.out.some((a) => a.type === "say")) return;
      await enqueueJob(MEMORY_EMBED_JOB, { chatId: tc.chat.id, messageIds, turnId: tc.turnId });
    } catch (err) {
      log.warn({ chatId: tc.chat.id, err: (err as Error).message }, "could not queue memory embedding");
    }
  },

  async onTripLocked(trip, tc) {
    if (!trip.destination_name) return;
    const dates = trip.start_date && trip.end_date ? ` for ${formatRange(trip.start_date, trip.end_date)}` : "";
    await enqueueJob(MEMORY_DECISION_JOB, { chatId: tc.chat.id, text: `the group locked ${trip.destination_name}${dates}`, at: tc.now.toISOString(), tripId: trip.id }).catch(() => undefined);
  },

  jobs(svc) {
    return {
      [MEMORY_EMBED_JOB]: async (payload) => {
        const chatId = Number(payload.chatId);
        if (!Number.isInteger(chatId)) return;
        const ids = (Array.isArray(payload.messageIds) ? payload.messageIds : []).map(Number).filter((id) => Number.isInteger(id));
        const turnId = Number(payload.turnId);
        if (Number.isInteger(turnId)) {
          const turn = await one<{ status: string; started_at: Date }>(`SELECT status, started_at FROM turns WHERE id = $1`, [turnId]);
          // The turn may still be sending its replies; come back once they're logged.
          if (turn?.status === "running" && now().getTime() - turn.started_at.getTime() < TURN_WAIT_MS) return { rescheduleAt: new Date(now().getTime() + 3_000) };
          const out = await q<{ id: number }>(`SELECT id FROM messages WHERE chat_id = $1 AND turn_id = $2 AND direction = 'outbound'`, [chatId, turnId]);
          ids.push(...out.map((r) => r.id));
        }
        if (ids.length === 0) return;
        await embedTurn({ llm: svc.llm, chatId, messageIds: ids, agentName: svc.cfg.AGENT_NAME });
      },
      [MEMORY_DECISION_JOB]: async (payload) => {
        const chatId = Number(payload.chatId);
        const text = typeof payload.text === "string" ? payload.text : "";
        const at = typeof payload.at === "string" ? new Date(payload.at) : now();
        if (!Number.isInteger(chatId) || !text) return;
        await rememberDecision({ llm: svc.llm, chatId, text, at: Number.isNaN(at.getTime()) ? now() : at, meta: { tripId: payload.tripId ?? null, kind: "trip_locked" } });
      },
    };
  },
};
