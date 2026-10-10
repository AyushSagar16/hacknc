// Fact persistence and profile loading (memory scoped per person, across chats).
import { db, q, type Queryable } from "../db/pool.ts";
import { aggregate, supersededFacts, type PersonProfile } from "./aggregate.ts";
import type { Fact, FactKey } from "./schema.ts";

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
}

export async function insertFacts(facts: NewFact[], on: Queryable = db()): Promise<number[]> {
  const ids: number[] = [];
  for (const f of facts) {
    const rows = await q<{ id: number }>(
      `INSERT INTO facts (person_id, chat_id, key, value, polarity, explicit, confidence, visibility, source_message_id, quote, observed_at, retracted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [f.personId, f.chatId, f.key, JSON.stringify(f.value), f.polarity, f.explicit, f.confidence, f.visibility ?? "public", f.sourceMessageId, f.quote, f.observedAt, f.retracted],
      on,
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

export async function factsFor(personIds: number[], on: Queryable = db()): Promise<Fact[]> {
  if (personIds.length === 0) return [];
  const rows = await q<FactRow>(`SELECT * FROM facts WHERE person_id = ANY($1) ORDER BY observed_at, id`, [personIds], on);
  return rows.map(toFact);
}

export async function profilesFor(personIds: number[], on: Queryable = db()): Promise<Map<number, PersonProfile>> {
  const facts = await factsFor(personIds, on);
  const out = new Map<number, PersonProfile>();
  for (const id of personIds) out.set(id, aggregate(id, facts));
  return out;
}

/** Record which facts were overridden (audit trail shown in the console). */
export async function markSuperseded(personIds: number[]): Promise<void> {
  const facts = await factsFor(personIds);
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
