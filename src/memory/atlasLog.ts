// Atlas's memory of its own words (atlas_log hypertable). Every bubble Atlas sends is classified
// deterministically (no model call): what kind of message it was, which members it named, and which
// details it asked for. The agent reads its open asks back each turn, and an unprompted follow-up
// that restates a recent ask or nudge (pg_trgm similarity) is dropped before it's sent.
import { q } from "../db/pool.ts";

export type LogKind = "ask" | "nudge" | "proposal" | "decision" | "money" | "answer" | "other";

/** A follow-up this similar to a recent ask/nudge (pg_trgm, 0–1) restates it and isn't sent. */
export const REPEAT_SIMILARITY = 0.6;
export const REPEAT_WINDOW_MS = 6 * 3_600_000;
/** How far back the agent's "what you already said" section looks. */
export const OPEN_ASK_WINDOW_MS = 24 * 3_600_000;

const FIELD_PATTERNS: [string, RegExp][] = [
  ["dates", /\b(dates?|when (?:you'?re|are you|you are) free|free when|what (?:days|weekend)|availability)\b/i],
  ["home_city", /\b(leaving from|flying (?:out of|from)|where (?:you'?d|would you|you'll) (?:be )?leav|home city|where are you based)\b/i],
  ["budget", /\b(budget|spend|afford)\b/i],
  ["vote", /\b(vote|votes|poll)\b/i],
  ["confirm", /\breply "?(?:yes|confirm)"?\b/i],
];

export function fieldsAsked(text: string): string[] {
  return FIELD_PATTERNS.filter(([, re]) => re.test(text)).map(([f]) => f);
}

/** What a bubble is, from its words and whether the turn was unprompted (a follow-up or chime-in). */
export function classify(text: string, opts: { unprompted: boolean; actionType?: string }): LogKind {
  const t = text.toLowerCase();
  if (opts.actionType === "poll" || /^\d\. /m.test(text) || /\boptions? for\b|\bspots? (?:that )?fit\b/.test(t)) return "proposal";
  if (/\b(it is!|locked in\b|we're going\b|going with\b)/.test(t)) return "decision";
  if (/\$\d/.test(text) && /\b(payments?|owes?|shares?|settle|logged|split|total)\b/.test(t)) return "money";
  const asks = /\?\s*$|\?\s*\n/.test(text) || fieldsAsked(text).length > 0;
  if (asks) return opts.unprompted ? "nudge" : "ask";
  return opts.unprompted ? "nudge" : "answer";
}

export interface Member {
  id: number;
  first: string;
}

/** Members a bubble names ("sai and ravi, …"), by first name as a whole word. */
export function targetsOf(text: string, members: Member[]): number[] {
  const t = text.toLowerCase();
  return members.filter((m) => m.first.length >= 2 && new RegExp(`\\b${m.first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)).map((m) => m.id);
}

async function membersOf(chatId: number): Promise<Member[]> {
  const rows = await q<{ id: number; display_name: string | null; handle: string | null }>(
    `SELECT p.id, p.display_name, p.handle FROM chat_members cm JOIN people p ON p.id = cm.person_id WHERE cm.chat_id = $1 AND cm.active AND cm.left_at IS NULL`,
    [chatId],
  );
  return rows.map((r) => ({ id: Number(r.id), first: (r.display_name ?? "").toLowerCase().split(/\s+/)[0] ?? "" })).filter((m) => m.first);
}

export async function logSent(entry: { chatId: number; turnId: number | null; text: string; unprompted: boolean; actionType: string; at: Date }): Promise<void> {
  const text = entry.text.trim();
  if (!text) return;
  const members = await membersOf(entry.chatId);
  await q(`INSERT INTO atlas_log (at, chat_id, turn_id, kind, unprompted, targets, fields, text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    entry.at,
    entry.chatId,
    entry.turnId,
    classify(text, { unprompted: entry.unprompted, actionType: entry.actionType }),
    entry.unprompted,
    targetsOf(text, members),
    fieldsAsked(text),
    text.slice(0, 2_000),
  ]);
}

/** The recent ask/nudge this text restates, if any (so an unprompted follow-up can be dropped). */
export async function restates(chatId: number, text: string, at: Date): Promise<{ text: string; similarity: number } | undefined> {
  const rows = await q<{ text: string; similarity: number }>(
    `SELECT text, similarity(text, $2) AS similarity FROM atlas_log
     WHERE chat_id = $1 AND at > $3 AND kind IN ('ask', 'nudge') AND similarity(text, $2) > $4
     ORDER BY similarity DESC LIMIT 1`,
    [chatId, text, new Date(at.getTime() - REPEAT_WINDOW_MS), REPEAT_SIMILARITY],
  );
  return rows[0] ? { text: rows[0].text, similarity: Number(rows[0].similarity) } : undefined;
}

export interface OpenAsk {
  at: Date;
  kind: LogKind;
  text: string;
  fields: string[];
  /** Named people who haven't said anything since. */
  waitingOn: number[];
  /** Named people who have. */
  answered: number[];
}

/** Asks and nudges from the last day, with who has (and hasn't) spoken since each one. */
export async function openAsks(chatId: number, at: Date): Promise<OpenAsk[]> {
  const rows = await q<{ at: Date; kind: LogKind; text: string; fields: string[]; targets: string[]; spoke: string[] | null }>(
    `SELECT l.at, l.kind, l.text, l.fields, l.targets,
            (SELECT array_agg(DISTINCT m.person_id) FROM messages m
              WHERE m.chat_id = l.chat_id AND m.direction = 'inbound' AND m.sent_at > l.at AND m.person_id = ANY(l.targets)) AS spoke
     FROM atlas_log l
     WHERE l.chat_id = $1 AND l.at > $2 AND l.kind IN ('ask', 'nudge')
     ORDER BY l.at DESC LIMIT 8`,
    [chatId, new Date(at.getTime() - OPEN_ASK_WINDOW_MS)],
  );
  return rows.map((r) => {
    const targets = (r.targets ?? []).map(Number);
    const spoke = new Set((r.spoke ?? []).map(Number));
    return { at: r.at, kind: r.kind, text: r.text, fields: r.fields ?? [], waitingOn: targets.filter((t) => !spoke.has(t)), answered: targets.filter((t) => spoke.has(t)) };
  });
}

export function ago(from: Date, to: Date): string {
  const min = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
