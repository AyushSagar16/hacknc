// Adapted from ethanyanghq/scout src/scout/polls.py @ 60f567b89916edb908129c868e3dd4be664b0e07
// Original author: Ethan Yang — used and adapted with the author's explicit permission.
// Changes: ported to TypeScript; strips "@atlas"/"atlas" instead of "@scout"; Unicode-aware
// punctuation stripping plus accent folding ("cancun" votes for "Cancún"); "#" may follow
// another prefix ("vote #2"); tally() replaces decide_winner() with per-person latest-state
// counting, multi-select, a majority-or-everyone decision rule, and cost-then-index
// tie-breaks; poll formatting lives elsewhere.
//
// Parsing is deliberately strict: "tulum looks pricey" is chatter, not a vote. Anything looser
// goes to the agent, which can record a vote by tool.

const VOTE_PREFIXES = ["i vote for", "i vote", "vote for", "vote", "option", "number", "#"] as const;
const ATLAS_MENTION = /@?\batlas\b/giu;

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(ATLAS_MENTION, " ")
    .replace(/[^\p{L}\p{N}_\s#]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** The 0-based option a message votes for ("2", "#3", "option 1", "tulum"), or null. */
export function parseVote(text: string, optionTitles: readonly string[]): number | null {
  let vote = normalize(text);
  for (const prefix of VOTE_PREFIXES) {
    if (vote.startsWith(prefix)) {
      vote = vote.slice(prefix.length).trim();
      break;
    }
  }
  if (vote.startsWith("#")) vote = vote.slice(1).trim(); // "vote #2", "option #2"

  if (/^\d+$/.test(vote)) {
    const n = Number(vote);
    return n >= 1 && n <= optionTitles.length ? n - 1 : null;
  }
  if (!vote) return null;

  for (let i = 0; i < optionTitles.length; i++) {
    const title = optionTitles[i]!;
    const full = normalize(title);
    // "Tulum, Mexico" can be voted for as just "tulum".
    const short = normalize(title.split(",")[0] ?? title);
    if (vote === full || vote === short) return i;
  }
  return null;
}

export interface VoteEvent {
  personId: number;
  optionIdx: number;
  /** false when someone takes a vote back (un-tapback, "actually not 2"). */
  selected: boolean;
}

export interface Tally {
  counts: number[];
  /** People with at least one option currently selected. */
  voters: number;
  leader: number | null;
  decided: boolean;
  winner: number | null;
  /** More than one option shares the top count. */
  tie: boolean;
}

/**
 * Count votes in arrival order. Each person counts at most once per option and their latest
 * selected state wins; selecting several options is allowed. The poll is decided when the
 * leader has a strict majority of the group or every member has voted. Ties go to the lowest
 * cost when costs are given, else the lowest index. No votes, no winner.
 */
export function tally(
  options: number,
  votes: readonly VoteEvent[],
  groupSize: number,
  costs?: readonly number[],
): Tally {
  const state = new Map<number, Map<number, boolean>>();
  for (const v of votes) {
    if (!Number.isInteger(v.optionIdx) || v.optionIdx < 0 || v.optionIdx >= options) continue;
    const mine = state.get(v.personId) ?? new Map<number, boolean>();
    mine.set(v.optionIdx, v.selected);
    state.set(v.personId, mine);
  }

  const counts = Array.from({ length: Math.max(0, options) }, () => 0);
  let voters = 0;
  for (const mine of state.values()) {
    let any = false;
    for (const [idx, selected] of mine) {
      if (!selected) continue;
      counts[idx]! += 1;
      any = true;
    }
    if (any) voters += 1;
  }

  const top = counts.length ? Math.max(...counts) : 0;
  if (top === 0) return { counts, voters, leader: null, decided: false, winner: null, tie: false };

  const leaders = counts.flatMap((c, i) => (c === top ? [i] : []));
  const costOf = (i: number): number => costs?.[i] ?? Number.POSITIVE_INFINITY;
  const leader = leaders.reduce((best, i) => (costOf(i) < costOf(best) ? i : best));
  const decided = top * 2 > groupSize || voters >= groupSize;
  return { counts, voters, leader, decided, winner: decided ? leader : null, tie: leaders.length > 1 };
}

export interface StoredVote extends VoteEvent {
  source: string;
  votedAt: Date;
}

export interface ProviderVote {
  personId: number;
  optionIdx: number;
  /** When the provider says they voted (absent if it didn't say). */
  votedAt?: Date;
}

export interface VoteChange {
  personId: number;
  optionIdx: number;
  selected: boolean;
  source: string;
  at: Date;
}

/**
 * Bring stored votes in line with a native poll's authoritative voter list. Pure and idempotent:
 * applying the changes and running it again yields no changes.
 *  - A provider vote missing locally is added (source native), unless the person took that
 *    option back here more recently than the provider's timestamp (a later text pick or removal).
 *  - A local native vote the provider no longer lists is taken back, once it's older than
 *    `graceMs` (the poll API can lag the webhook that recorded it).
 *  - Someone the provider lists stops counting for a different option they picked by text,
 *    tapback or agent before their latest native vote, so voting both ways never double-counts.
 */
export function reconcileVotes(stored: readonly StoredVote[], provider: readonly ProviderVote[], opts: { now: Date; graceMs?: number }): VoteChange[] {
  const grace = opts.graceMs ?? 60_000;
  const key = (p: number, o: number) => `${p}:${o}`;
  const local = new Map<string, StoredVote>();
  for (const v of stored) local.set(key(v.personId, v.optionIdx), v);
  const listed = new Map<string, ProviderVote>();
  for (const v of provider) listed.set(key(v.personId, v.optionIdx), v);

  const changes: VoteChange[] = [];
  for (const v of listed.values()) {
    const mine = local.get(key(v.personId, v.optionIdx));
    if (mine?.selected) continue;
    if (mine && (!v.votedAt || mine.votedAt.getTime() > v.votedAt.getTime())) continue;
    changes.push({ personId: v.personId, optionIdx: v.optionIdx, selected: true, source: "native", at: v.votedAt ?? opts.now });
  }
  for (const mine of local.values()) {
    if (!mine.selected || mine.source !== "native" || listed.has(key(mine.personId, mine.optionIdx))) continue;
    if (opts.now.getTime() - mine.votedAt.getTime() < grace) continue;
    changes.push({ personId: mine.personId, optionIdx: mine.optionIdx, selected: false, source: "native", at: opts.now });
  }
  const latestNative = new Map<number, number>();
  for (const v of provider) if (v.votedAt) latestNative.set(v.personId, Math.max(latestNative.get(v.personId) ?? 0, v.votedAt.getTime()));
  for (const mine of local.values()) {
    if (!mine.selected || mine.source === "native" || listed.has(key(mine.personId, mine.optionIdx))) continue;
    const latest = latestNative.get(mine.personId);
    if (latest === undefined || mine.votedAt.getTime() > latest) continue;
    changes.push({ personId: mine.personId, optionIdx: mine.optionIdx, selected: false, source: mine.source, at: opts.now });
  }
  return changes;
}
