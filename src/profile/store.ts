// Fact persistence and profile loading. Each group chat is its own sandbox: a person's facts are
// read only in the chat they were said in, so one group's plans never reach another. Inside a
// chat, facts about the person (diet, home city...) follow them across trips; trip facts don't.
import { db, q, type Queryable } from "../db/pool.ts";
import { tripFor } from "../trips/state.ts";
import { aggregate, supersededFacts, type PersonProfile } from "./aggregate.ts";
import { TRIP_SCOPED_KEYS, type Fact, type FactKey } from "./schema.ts";

interface FactRow {
  id: number;
  person_id: number;
  key: FactKey;
  value: Record<string, unknown>;
  polarity: Fact["polarity"];
  explicit: boolean;
  confidence: number;
  visibility: Fact["visibility"];
  source_message_id: number | null;
  quote: string | null;
  observed_at: Date;
  retracted: boolean;
  reported_by?: number | null;
}

const toFact = (r: FactRow): Fact => ({
  id: r.id,
  personId: r.person_id,
  key: r.key,
  value: r.value,
  polarity: r.polarity,
  explicit: r.explicit,
  confidence: r.confidence,
  visibility: r.visibility,
  sourceMessageId: r.source_message_id,
  quote: r.quote,
  observedAt: r.observed_at,
  retracted: r.retracted,
  reportedBy: r.reported_by ?? null,
});

export interface NewFact {
  personId: number;
  chatId: number;
  key: FactKey;
  value: Record<string, unknown>;
  polarity: Fact["polarity"];
  explicit: boolean;
  confidence: number;
  visibility?: Fact["visibility"];
  sourceMessageId: number | null;
  quote: string | null;
  observedAt: Date;
  retracted: boolean;
  /** The sender; differs from personId when someone reports a friend's fact. */
  reportedBy?: number | null;
}

/**
 * Trip-scoped facts (where, when, how long, budget talk) are stamped with the trip their source
 * message was about, else the chat's focused trip (created if the chat has none yet), so a trip
 * fact never floats free and lands on every trip. Facts about the person stay unscoped.
 */
export async function insertFacts(facts: NewFact[], on: Queryable = db()): Promise<number[]> {
  const ids: number[] = [];
  for (const f of facts) {
    const tripId = TRIP_SCOPED_KEYS.has(f.key) ? await tripOf(f, on) : null;
    const rows = await q<{ id: number }>(
      `INSERT INTO facts (person_id, chat_id, key, value, polarity, explicit, confidence, visibility, source_message_id, quote, observed_at, retracted, reported_by, trip_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [f.personId, f.chatId, f.key, JSON.stringify(f.value), f.polarity, f.explicit, f.confidence, f.visibility ?? "public", f.sourceMessageId, f.quote, f.observedAt, f.retracted, f.reportedBy ?? null, tripId],
      on,
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

async function tripOf(f: NewFact, on: Queryable): Promise<number> {
  if (f.sourceMessageId !== null) {
    const [row] = await q<{ trip_id: number | null }>(`SELECT trip_id FROM messages WHERE id = $1 AND chat_id = $2`, [f.sourceMessageId, f.chatId], on);
    if (row?.trip_id) return row.trip_id;
  }
  return (await tripFor(f.chatId, on)).id;
}

/** Where facts are read: always one chat; with `tripId`, only that trip's trip-scoped facts. */
export interface FactScope {
  chatId: number;
  tripId?: number;
}

/**
 * Facts said in this chat only. With `tripId`, trip-scoped facts from other trips are left out,
 * and so is any trip-scoped fact with no trip (person facts always count).
 */
export async function factsFor(personIds: number[], scope: FactScope, on: Queryable = db()): Promise<Fact[]> {
  if (personIds.length === 0) return [];
  const rows = await q<FactRow>(
    `SELECT * FROM facts
      WHERE person_id = ANY($1) AND chat_id = $2
        AND ($3::bigint IS NULL OR trip_id = $3 OR (trip_id IS NULL AND key <> ALL($4::text[])))
      ORDER BY observed_at, id`,
    [personIds, scope.chatId, scope.tripId ?? null, [...TRIP_SCOPED_KEYS]],
    on,
  );
  return rows.map(toFact);
}

export async function profilesFor(personIds: number[], scope: FactScope, on: Queryable = db()): Promise<Map<number, PersonProfile>> {
  const facts = await factsFor(personIds, scope, on);
  const out = new Map<number, PersonProfile>();
  for (const id of personIds) out.set(id, aggregate(id, facts));
  return out;
}

/** Record which facts were overridden (audit trail shown in the console). */
export async function markSuperseded(personIds: number[], scope: FactScope): Promise<void> {
  const facts = await factsFor(personIds, scope);
  for (const [loser, winner] of supersededFacts(facts)) {
    await q(`UPDATE facts SET superseded_by = $2 WHERE id = $1 AND superseded_by IS DISTINCT FROM $2`, [loser, winner]);
  }
}

export async function recordAsk(personId: number, chatId: number, field: string, at: Date): Promise<boolean> {
  const rows = await q(`INSERT INTO asks (person_id, chat_id, field, asked_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING person_id`, [personId, chatId, field, at]);
  return rows.length > 0;
}

export async function askedFields(chatId: number): Promise<Set<string>> {
  const rows = await q<{ person_id: number; field: string }>(`SELECT person_id, field FROM asks WHERE chat_id = $1`, [chatId]);
  return new Set(rows.map((r) => `${r.person_id}:${r.field}`));
}
