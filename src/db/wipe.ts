// Wipes of Atlas's memory, shared by the operator script (`npm run memory:reset`) and the
// "atlas onboard" command. Not a migration on purpose: this must only ever run when someone asks.
import { q, tx, type Queryable } from "./pool.ts";

/** Instance-wide memory: extracted facts, recall chunks, asks and Atlas's own log. Chats, people, trips stay. */
export const MEMORY_TABLES = ["facts", "memory_chunks", "asks", "atlas_log"] as const;

export async function countMemory(): Promise<Array<[string, number]>> {
  return Promise.all(MEMORY_TABLES.map(async (t) => [t, (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n] as [string, number]));
}

export async function wipeMemory(): Promise<void> {
  await q(`TRUNCATE ${MEMORY_TABLES.join(", ")}`);
}

/**
 * Forget everything about one chat and put it back to its just-added state, in one transaction:
 * its trips and all that hangs off them, facts learned there, recall chunks, asks, confirmations,
 * bank-connect asks, pending jobs, outbox, turns and message history. Chat row, chat members and
 * people stay, as do per-person things not scoped to this chat (bank links, person-level memory
 * chunks and facts with no chat or trip). `keepTurnId`: the running turn's rows (its messages and
 * turn record) survive so the turn can finish; unclaimed inbound messages survive too.
 */
export async function wipeChat(chatId: number, opts: { keepTurnId?: number | null } = {}): Promise<void> {
  const keep = opts.keepTurnId ?? null;
  await tx(async (c: Queryable) => {
    const trips = `(SELECT id FROM trips WHERE chat_id = $1)`;
    // The messages going away: everything in the chat except the running turn's and the unclaimed queue.
    const doomed = `(SELECT id FROM messages WHERE chat_id = $1 AND NOT (turn_id IS NULL AND direction = 'inbound') AND COALESCE(turn_id, 0) <> COALESCE($2::bigint, -1))`;
    const polls = `(SELECT id FROM polls WHERE chat_id = $1 OR trip_id IN ${trips})`;
    const run = (sql: string, withKeep = false) => q(sql, withKeep ? [chatId, keep] : [chatId], c);

    // Queued work for this chat or its trips must not fire into the fresh chat.
    await run(
      `DELETE FROM jobs WHERE done_at IS NULL AND failed_at IS NULL AND (
         payload->>'chatId' IN (SELECT id::text FROM chats WHERE id = $1)
         OR payload->>'tripId' IN (SELECT id::text FROM trips WHERE chat_id = $1)
         OR payload->>'pollId' IN (SELECT id::text FROM polls WHERE chat_id = $1 OR trip_id IN ${trips})
         OR payload->>'expenseId' IN (SELECT id::text FROM expenses WHERE trip_id IN ${trips})
         OR payload->>'settlementId' IN (SELECT id::text FROM settlements WHERE trip_id IN ${trips}))`,
    );
    await run(`UPDATE chats SET focus_trip_id = NULL, intro_sent_at = NULL, quiet_mode = false WHERE id = $1`);
    await run(`UPDATE messages SET trip_id = NULL WHERE chat_id = $1`);

    // Trip data, leaves first.
    await run(`DELETE FROM votes WHERE poll_id IN ${polls}`);
    await run(`DELETE FROM polls WHERE id IN ${polls}`);
    await run(`DELETE FROM proposals WHERE trip_id IN ${trips}`);
    for (const t of ["installments", "settlements", "expenses", "budgets", "weather_alerts", "weather_overrides", "weather_snapshots", "spend_events", "trip_research", "travel_plans", "fund_txns", "fund_items", "trip_funds", "trip_places"]) {
      await run(`DELETE FROM ${t} WHERE trip_id IN ${trips}`);
    }

    // Facts learned here (in this chat, for its trips, or read from messages being deleted). Facts
    // from other chats that these superseded become current again.
    const doomedFacts = `(SELECT id FROM facts WHERE chat_id = $1 OR trip_id IN ${trips} OR source_message_id IN ${doomed})`;
    await run(`UPDATE facts SET superseded_by = NULL WHERE superseded_by IN ${doomedFacts} AND id NOT IN ${doomedFacts}`, true);
    await run(`DELETE FROM facts WHERE id IN ${doomedFacts}`, true);

    await run(`DELETE FROM memory_chunks WHERE chat_id = $1`);
    await run(`DELETE FROM asks WHERE chat_id = $1`);
    await run(`DELETE FROM confirmations WHERE chat_id = $1`);
    await run(`DELETE FROM bank_connections WHERE chat_id = $1`);
    await run(`DELETE FROM atlas_log WHERE chat_id = $1`);
    await run(`DELETE FROM llm_traces WHERE chat_id = $1`);
    await run(`DELETE FROM outbox WHERE chat_id = $1 AND COALESCE(turn_id, 0) <> COALESCE($2::bigint, -1)`, true);
    await run(`DELETE FROM messages WHERE id IN ${doomed}`, true);
    await run(`DELETE FROM turns WHERE chat_id = $1 AND id IS DISTINCT FROM $2::bigint`, true);
    await run(`DELETE FROM trips WHERE chat_id = $1`);
  });
}
