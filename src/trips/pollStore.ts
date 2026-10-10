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

export async function recordVote(pollId: number, personId: number, optionIdx: number, selected: boolean, source: string, at: Date, opts: { single?: boolean } = {}): Promise<void> {
  // Text and tapback votes are single-choice: a new pick replaces the old one.
  if (opts.single && selected) await q(`UPDATE votes SET selected = false, voted_at = $3 WHERE poll_id = $1 AND person_id = $2 AND option_idx <> $4`, [pollId, personId, at, optionIdx]);
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
