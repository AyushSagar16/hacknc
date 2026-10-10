// Long-term memory, write side (Tiger Data: pgvector + pgvectorscale's diskann index).
// Memory per person, history per chat: each turn's messages become "window" chunks scoped to the
// chat they were said in, and each extracted fact becomes a chunk scoped to the person it's about
// (recalled in any chat that person is in). Decisions ("the group locked lisbon") are chat-scoped.
// Embeddings go through the Llm interface, so tests and scenarios use the deterministic hash
// embedder. Re-running is idempotent: covered messages and already-embedded facts are skipped.
import { config } from "../config.ts";
import { one, q, tx } from "../db/pool.ts";
import { labelOf } from "../db/repos/core.ts";
import { EMBED_DIM, type Llm } from "../agent/llm.ts";
import { MIN_CONFIDENCE } from "../profile/aggregate.ts";

export const WINDOW_MAX_CHARS = 2_400;
/** A pause this long starts a new window even inside one batch of messages. */
export const WINDOW_GAP_MS = 60 * 60_000;

export type ChunkKind = "message" | "fact" | "decision";
export type Visibility = "public" | "private";

export interface ChunkDraft {
  chatId: number | null;
  personId: number | null;
  kind: ChunkKind;
  content: string;
  visibility: Visibility;
  sourceIds: number[];
  meta: Record<string, unknown>;
  createdAt: Date;
}

export interface EmbedTurnInput {
  llm: Llm;
  chatId: number;
  /** Inbound and outbound message ids from one turn (anything else is ignored). */
  messageIds: number[];
  /** How Atlas's own lines are labeled; defaults to AGENT_NAME. */
  agentName?: string;
}

export interface EmbedTurnResult {
  windows: number;
  facts: number;
  ids: number[];
}

interface MessageRowLite {
  id: number;
  person_id: number | null;
  direction: "inbound" | "outbound";
  text: string;
  sent_at: Date;
  display_name: string | null;
  handle: string | null;
}

interface FactRowLite {
  id: number;
  person_id: number;
  chat_id: number | null;
  key: string;
  value: Record<string, unknown>;
  polarity: "positive" | "negative" | "neutral";
  visibility: Visibility;
  quote: string | null;
  observed_at: Date;
  retracted: boolean;
  source_message_id: number | null;
  display_name: string | null;
  handle: string | null;
}

/**
 * Embed one turn: new window chunks for messages no chunk covers yet, plus a fact chunk for every
 * fact from those messages (or anywhere in this chat) that isn't embedded yet. One embed call.
 */
export async function embedTurn(input: EmbedTurnInput): Promise<EmbedTurnResult> {
  const chat = await one<{ id: number; is_group: boolean }>(`SELECT id, is_group FROM chats WHERE id = $1`, [input.chatId]);
  if (!chat) return { windows: 0, facts: 0, ids: [] };
  const agentLabel = (input.agentName ?? config().AGENT_NAME).toLowerCase();
  const ids = [...new Set(input.messageIds.filter((id) => Number.isInteger(id)))];
  const windows = await windowDrafts(chat, ids, agentLabel);
  const facts = await factDrafts(chat.id, ids);
  const drafts = [...windows, ...facts];
  if (drafts.length === 0) return { windows: 0, facts: 0, ids: [] };
  const vectors = await input.llm.embed(
    drafts.map((d) => d.content),
    "document",
  );
  const inserted = await insertChunks(drafts, vectors);
  return { windows: windows.length, facts: facts.length, ids: inserted };
}

/** Remember a group decision (e.g. "the group locked lisbon for nov 11–14"); identical text per chat is stored once. */
export async function rememberDecision(input: { llm: Llm; chatId: number; text: string; at: Date; meta?: Record<string, unknown> }): Promise<number | undefined> {
  const content = input.text.trim().replace(/\s+/g, " ").slice(0, WINDOW_MAX_CHARS);
  if (!content) return undefined;
  const existing = await one(`SELECT id FROM memory_chunks WHERE chat_id = $1 AND kind = 'decision' AND content = $2 LIMIT 1`, [input.chatId, content]);
  if (existing) return undefined;
  const vectors = await input.llm.embed([content], "document");
  const [id] = await insertChunks(
    [{ chatId: input.chatId, personId: null, kind: "decision", content, visibility: "public", sourceIds: [], meta: input.meta ?? {}, createdAt: input.at }],
    vectors,
  );
  return id;
}

// ---------- message windows ----------

async function windowDrafts(chat: { id: number; is_group: boolean }, ids: number[], agentLabel: string): Promise<ChunkDraft[]> {
  if (ids.length === 0) return [];
  const coveredRows = await q<{ id: number }>(
    `SELECT DISTINCT s.id FROM memory_chunks mc CROSS JOIN LATERAL unnest(mc.source_ids) AS s(id)
     WHERE mc.chat_id = $1 AND mc.kind = 'message' AND mc.source_ids && $2::bigint[]`,
    [chat.id, ids],
  );
  const covered = new Set(coveredRows.map((r) => r.id));
  const rows = await q<MessageRowLite>(
    `SELECT m.id, m.person_id, m.direction, m.text, m.sent_at, p.display_name, p.handle
     FROM messages m LEFT JOIN people p ON p.id = m.person_id
     WHERE m.chat_id = $1 AND m.id = ANY($2::bigint[]) AND m.kind = 'text' AND btrim(m.text) <> ''
     ORDER BY m.sent_at, m.id`,
    [chat.id, ids],
  );
  const fresh = rows.filter((r) => !covered.has(r.id));
  if (fresh.length === 0) return [];

  const lineOf = (m: MessageRowLite): string => {
    const who = m.direction === "outbound" || m.person_id === null ? agentLabel : labelOf({ display_name: m.display_name, handle: m.handle });
    return clip(`[${who}] ${m.text.trim().replace(/\s*\n\s*/g, " ")}`, WINDOW_MAX_CHARS);
  };

  const groups: { msgs: MessageRowLite[]; lines: string[] }[] = [];
  let cur: { msgs: MessageRowLite[]; lines: string[]; len: number } | undefined;
  for (const m of fresh) {
    const line = lineOf(m);
    const last = cur?.msgs[cur.msgs.length - 1];
    const tooLong = cur !== undefined && cur.len + 1 + line.length > WINDOW_MAX_CHARS;
    const gap = last !== undefined && m.sent_at.getTime() - last.sent_at.getTime() > WINDOW_GAP_MS;
    if (!cur || tooLong || gap) {
      cur = { msgs: [], lines: [], len: -1 };
      groups.push(cur);
    }
    cur.msgs.push(m);
    cur.lines.push(line);
    cur.len += 1 + line.length;
  }

  // In a 1:1 chat the history is that person's own: private to them, never shown in a group.
  const owner = chat.is_group ? null : (fresh.find((m) => m.person_id !== null)?.person_id ?? (await dmOwner(chat.id)));
  return groups
    .filter((g) => g.msgs.some((m) => m.direction === "outbound" || !isTrivial(m.text)))
    .map((g) => ({
      chatId: chat.id,
      personId: owner,
      kind: "message" as const,
      content: g.lines.join("\n"),
      visibility: chat.is_group ? ("public" as const) : ("private" as const),
      sourceIds: g.msgs.map((m) => m.id),
      meta: { messages: g.msgs.length },
      createdAt: g.msgs[g.msgs.length - 1]!.sent_at,
    }));
}

async function dmOwner(chatId: number): Promise<number | null> {
  const row = await one<{ person_id: number }>(`SELECT person_id FROM chat_members WHERE chat_id = $1 ORDER BY joined_at, person_id LIMIT 1`, [chatId]);
  return row?.person_id ?? null;
}

const ACKS = new Set([
  "ok", "okay", "k", "kk", "okok", "sure", "yes", "yeah", "yea", "yep", "yup", "ya", "no", "nah", "nope", "lol", "lmao", "lmfao",
  "haha", "hahaha", "hah", "ha", "cool", "nice", "bet", "true", "same", "ty", "thanks", "thx", "word", "fr", "omg", "wow", "hm", "hmm",
  "mhm", "sounds", "good", "great", "perfect", "alright", "aight", "gotcha", "got", "it", "kinda", "maybe", "idk", "np", "yay",
]);

/** A message made only of acknowledgements ("ok", "haha yes", "sounds good") carries nothing worth recalling on its own. */
export function isTrivial(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.every((w) => ACKS.has(w));
}

// ---------- facts ----------

async function factDrafts(chatId: number, ids: number[]): Promise<ChunkDraft[]> {
  // Facts from this turn's messages, plus any fact in this chat that a retried extraction added later.
  const rows = await q<FactRowLite>(
    `SELECT f.id, f.person_id, f.chat_id, f.key, f.value, f.polarity, f.visibility, f.quote, f.observed_at, f.retracted,
            f.source_message_id, p.display_name, p.handle
     FROM facts f JOIN people p ON p.id = f.person_id
     WHERE (f.source_message_id = ANY($2::bigint[]) OR f.chat_id = $1) AND f.confidence >= $3
       AND NOT EXISTS (SELECT 1 FROM memory_chunks mc WHERE mc.kind = 'fact' AND mc.person_id = f.person_id AND mc.meta->>'factId' = f.id::text)
     ORDER BY f.observed_at, f.id`,
    [chatId, ids, MIN_CONFIDENCE],
  );
  return rows.map((f) => ({
    chatId: f.chat_id,
    personId: f.person_id,
    kind: "fact" as const,
    content: describeFact(labelOf({ display_name: f.display_name, handle: f.handle }), f),
    visibility: f.visibility,
    sourceIds: f.source_message_id === null ? [] : [f.source_message_id],
    meta: { factId: f.id, key: f.key },
    createdAt: f.observed_at,
  }));
}

/** One line per fact, in plain words with the person's own quote: `Maya vetoed Cancún — "cancun is too pricey for me"`. */
export function describeFact(
  name: string,
  f: { key: string; value: Record<string, unknown>; polarity: "positive" | "negative" | "neutral"; quote: string | null; retracted?: boolean },
): string {
  const v = f.value;
  const s = (k: string) => (typeof v[k] === "string" && (v[k] as string).trim() ? (v[k] as string).trim() : undefined);
  const n = (k: string) => (typeof v[k] === "number" && Number.isFinite(v[k]) ? (v[k] as number) : undefined);
  const words = (x: string | undefined) => (x ?? "").replace(/_/g, " ");
  const neg = f.polarity === "negative";
  let text: string;
  switch (f.key) {
    case "destination":
      text = neg ? `${name} vetoed ${s("name")}` : f.polarity === "neutral" ? `${name} mentioned ${s("name")}` : `${name} wants ${s("name")}`;
      break;
    case "date_window": {
      const from = s("earliest");
      const until = s("latest");
      text = `${name} can travel${from ? ` from ${day(from)}` : ""}${until ? ` until ${day(until)}` : ""}`;
      break;
    }
    case "blackout": {
      const start = s("start");
      const end = s("end");
      text = `${name} is busy ${start ? day(start) : "?"}${end && end !== start ? `–${day(end)}` : ""}`;
      break;
    }
    case "trip_length": {
      const min = n("minNights");
      const max = n("maxNights");
      text = `${name} wants ${min && max ? `${min}–${max} nights` : min ? `at least ${min} nights` : max ? `at most ${max} nights` : "a trip of some length"}`;
      break;
    }
    case "dietary":
      text = `${name}: ${neg ? "not " : ""}${words(s("need"))} (dietary)`;
      break;
    case "activity":
      text = neg ? `${name} is not into ${words(s("tag"))}` : f.polarity === "neutral" ? `${name} mentioned ${words(s("tag"))}` : `${name} likes ${words(s("tag"))}`;
      break;
    case "travel_limit": {
      const hours = n("hours");
      text = `${name}: ${words(s("kind"))}${hours ? ` (${hours}h)` : ""} (travel limit)`;
      break;
    }
    case "budget_comment": {
      // No amounts here: figures come from tools (the money guard), and the quote carries the words.
      const about = s("about");
      const kind = s("kind");
      text =
        kind === "too_expensive"
          ? `${name} said ${about ?? "it"} is too pricey`
          : kind === "tight"
            ? `${name} said money is tight`
            : kind === "flexible"
              ? `${name} is flexible on money`
              : `${name} set a budget ceiling${about ? ` for ${about}` : ""}`;
      break;
    }
    case "home_city":
      text = `${name} would leave from ${s("city")}`;
      break;
    case "name":
      text = `${name} goes by ${s("name")}`;
      break;
    default:
      text = `${name}: ${words(f.key)} ${JSON.stringify(v)}`;
  }
  const quote = f.quote?.trim() ? ` — "${f.quote.trim()}"` : "";
  return clip(`${f.retracted ? "(took back) " : ""}${text}${quote}`, WINDOW_MAX_CHARS);
}

const day = (iso: string): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
};

// ---------- storage ----------

/** pgvector text literal: `[0.1,0.2,...]`. */
export function vectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
}

async function insertChunks(drafts: ChunkDraft[], vectors: number[][]): Promise<number[]> {
  if (vectors.length !== drafts.length) throw new Error(`embedder returned ${vectors.length} vectors for ${drafts.length} chunks`);
  for (const v of vectors) if (v.length !== EMBED_DIM) throw new Error(`embedder returned a ${v.length}-dim vector (expected ${EMBED_DIM})`);
  return tx(async (client) => {
    const ids: number[] = [];
    for (const [i, d] of drafts.entries()) {
      const v = vectors[i]!;
      // An all-zero vector (nothing but stop words) has no direction; store it unindexed.
      const embedding = v.some((x) => x !== 0) ? vectorLiteral(v) : null;
      const row = await one<{ id: number }>(
        `INSERT INTO memory_chunks (chat_id, person_id, kind, content, embedding, visibility, source_ids, meta, created_at)
         VALUES ($1, $2, $3, $4, $5::vector, $6, $7::bigint[], $8, $9) RETURNING id`,
        [d.chatId, d.personId, d.kind, d.content, embedding, d.visibility, d.sourceIds, JSON.stringify(d.meta), d.createdAt],
        client,
      );
      ids.push(row!.id);
    }
    return ids;
  });
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
