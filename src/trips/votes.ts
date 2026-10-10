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
