// Polls and votes in Postgres. A poll is rendered natively (Linq/iMessage poll) or as numbered
// text bubbles; votes arrive as native poll_option events, tapbacks on an option bubble, or text.
import { db, one, q, type Queryable } from "../db/pool.ts";

export interface PollOptionRow {
  title: string;
  /** Free-form reference back to what the option means (a destination id, a swap plan...). */
  ref?: unknown;
  estimatedCostCents?: number;
}

export interface PollRow {
  id: number;
  trip_id: number;
  chat_id: number;
  kind: "destination" | "weather_swap" | "dates" | string;
  title: string;
  options: PollOptionRow[];
  provider_poll_id: string | null;
  option_message_ids: string[];
  rendered_as: "native" | "text";
  status: "open" | "closed";
  winner_idx: number | null;
  proposal_id: number | null;
  created_at: Date;
  closed_at: Date | null;
  /** When Atlas called out who hasn't voted (once per poll). */
  reminded_at?: Date | null;
}

export async function createPoll(
  p: { tripId: number; chatId: number; kind: string; title: string; options: PollOptionRow[]; proposalId?: number | null; at: Date },
  on: Queryable = db(),
): Promise<PollRow> {
  // One open poll per kind per chat: a new one replaces the old.
  await q(`UPDATE polls SET status = 'closed', closed_at = $3 WHERE chat_id = $1 AND kind = $2 AND status = 'open'`, [p.chatId, p.kind, p.at], on);
  const row = await one<PollRow>(
    `INSERT INTO polls (trip_id, chat_id, kind, title, options, proposal_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [p.tripId, p.chatId, p.kind, p.title, JSON.stringify(p.options), p.proposalId ?? null, p.at],
    on,
  );
  return row!;
}

export async function openPolls(chatId: number): Promise<PollRow[]> {
  return q<PollRow>(`SELECT * FROM polls WHERE chat_id = $1 AND status = 'open' ORDER BY id`, [chatId]);
}

export async function pollById(id: number): Promise<PollRow | undefined> {
  return one<PollRow>(`SELECT * FROM polls WHERE id = $1`, [id]);
}

export async function closePoll(id: number, winnerIdx: number | null, at: Date): Promise<void> {
  await q(`UPDATE polls SET status = 'closed', winner_idx = $2, closed_at = $3 WHERE id = $1`, [id, winnerIdx, at]);
}

export async function recordVote(
  pollId: number,
  personId: number,
  optionIdx: number,
  selected: boolean,
  source: string,
  at: Date,
  opts: { single?: boolean; supersedeNonNative?: boolean } = {},
): Promise<void> {
  // Text and tapback votes are single-choice: a new pick replaces the old one.
  if (opts.single && selected) await q(`UPDATE votes SET selected = false, voted_at = $3 WHERE poll_id = $1 AND person_id = $2 AND option_idx <> $4`, [pollId, personId, at, optionIdx]);
  // A native vote replaces the same person's earlier text/tapback pick for another option, so
  // nobody counts twice for having voted both ways (native polls may stay multi-select).
  if (opts.supersedeNonNative && selected)
    await q(`UPDATE votes SET selected = false, voted_at = $3 WHERE poll_id = $1 AND person_id = $2 AND option_idx <> $4 AND source <> 'native' AND selected`, [pollId, personId, at, optionIdx]);
  await q(
    `INSERT INTO votes (poll_id, person_id, option_idx, selected, source, voted_at) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (poll_id, person_id, option_idx) DO UPDATE SET selected = EXCLUDED.selected, source = EXCLUDED.source, voted_at = EXCLUDED.voted_at`,
    [pollId, personId, optionIdx, selected, source, at],
  );
}

export async function votesFor(pollId: number): Promise<{ personId: number; optionIdx: number; selected: boolean }[]> {
  const rows = await q<{ person_id: number; option_idx: number; selected: boolean }>(`SELECT person_id, option_idx, selected FROM votes WHERE poll_id = $1 ORDER BY voted_at`, [pollId]);
  return rows.map((r) => ({ personId: r.person_id, optionIdx: r.option_idx, selected: r.selected }));
}

export interface VoteRow {
  personId: number;
  optionIdx: number;
  selected: boolean;
  source: string;
  votedAt: Date;
}

/** Every vote row with its source and time (for reconciling against the provider's voter list). */
export async function voteRows(pollId: number): Promise<VoteRow[]> {
  const rows = await q<{ person_id: number; option_idx: number; selected: boolean; source: string; voted_at: Date }>(
    `SELECT person_id, option_idx, selected, source, voted_at FROM votes WHERE poll_id = $1 ORDER BY voted_at`,
    [pollId],
  );
  return rows.map((r) => ({ personId: Number(r.person_id), optionIdx: r.option_idx, selected: r.selected, source: r.source, votedAt: r.voted_at }));
}

/** Set one vote row exactly (no single-choice side effects). Idempotent. */
export async function setVote(pollId: number, personId: number, optionIdx: number, selected: boolean, source: string, at: Date): Promise<void> {
  await q(
    `INSERT INTO votes (poll_id, person_id, option_idx, selected, source, voted_at) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (poll_id, person_id, option_idx) DO UPDATE SET selected = EXCLUDED.selected, source = EXCLUDED.source, voted_at = EXCLUDED.voted_at`,
    [pollId, personId, optionIdx, selected, source, at],
  );
}

/** Open polls rendered as a native provider poll, across all chats (startup reconciliation). */
export async function openNativePolls(): Promise<PollRow[]> {
  return q<PollRow>(`SELECT * FROM polls WHERE status = 'open' AND rendered_as = 'native' AND provider_poll_id IS NOT NULL ORDER BY id`);
}

/** A closed poll in this chat matched by its native poll id or one of its option bubbles (late votes). */
export async function closedPollFor(chatId: number, ref: { providerPollId?: string | null; optionMessageId?: string | null }): Promise<PollRow | undefined> {
  if (ref.providerPollId) {
    const hit = await one<PollRow>(`SELECT * FROM polls WHERE chat_id = $1 AND status = 'closed' AND provider_poll_id = $2 ORDER BY id DESC LIMIT 1`, [chatId, ref.providerPollId]);
    if (hit) return hit;
  }
  if (ref.optionMessageId) {
    return one<PollRow>(`SELECT * FROM polls WHERE chat_id = $1 AND status = 'closed' AND option_message_ids @> $2::jsonb ORDER BY id DESC LIMIT 1`, [chatId, JSON.stringify([ref.optionMessageId])]);
  }
  return undefined;
}

/** The most recent decided poll of a kind in this chat (for "what did the vibe poll say"). */
export async function lastDecidedPoll(chatId: number, kind: string): Promise<PollRow | undefined> {
  return one<PollRow>(`SELECT * FROM polls WHERE chat_id = $1 AND kind = $2 AND status = 'closed' AND winner_idx IS NOT NULL ORDER BY closed_at DESC LIMIT 1`, [chatId, kind]);
}
