// Vote parsing ported from ethanyanghq/scout tests/test_polls.py (with the author's permission),
// plus Atlas's tally rules: latest state per person, multi-select, majority-or-everyone, cost ties.
import { describe, expect, it } from "vitest";
import { parseVote, reconcileVotes, tally, type StoredVote, type VoteChange, type VoteEvent } from "../../src/trips/votes.ts";

const OPTIONS = ["Tulum, Mexico", "San Juan, Puerto Rico", "Miami, Florida"];

describe("parseVote", () => {
  it.each([
    ["2", 1],
    ["2!", 1],
    ["#3", 2],
    ["option 1", 0],
    ["I vote 2", 1],
    ["i vote for 3", 2],
    ["vote #2", 1],
    ["number 1", 0],
    ["@atlas 2", 1],
    ["@Atlas, 2", 1],
    ["atlas 3", 2],
    ["tulum", 0],
    ["Tulum!!", 0],
    ["San Juan, Puerto Rico", 1],
    ["san juan", 1],
    ["I vote for Miami", 2],
    ["  MIAMI, florida ", 2],
  ])("reads %j as option %i", (text, expected) => {
    expect(parseVote(text, OPTIONS)).toBe(expected);
  });

  it.each(["tulum looks pricey tbh", "4", "0", "i'm free on the 2nd", "lol", "", "@atlas", "2 or 3", "miami or tulum"])(
    "ignores %j",
    (text) => {
      expect(parseVote(text, OPTIONS)).toBeNull();
    },
  );

  it("folds accents both ways", () => {
    const titles = ["Cancún, Mexico", "Medellín, Colombia"];
    expect(parseVote("cancun", titles)).toBe(0);
    expect(parseVote("Medellín", titles)).toBe(1);
  });
});

const v = (personId: number, optionIdx: number, selected = true): VoteEvent => ({ personId, optionIdx, selected });

describe("tally", () => {
  it("no votes, no winner", () => {
    expect(tally(3, [], 4)).toEqual({ counts: [0, 0, 0], voters: 0, leader: null, decided: false, winner: null, tie: false, deadlocked: false });
  });

  it("most votes leads; a strict majority of the group decides", () => {
    const early = tally(3, [v(1, 0), v(2, 0), v(3, 1)], 5);
    expect(early).toMatchObject({ counts: [2, 1, 0], voters: 3, leader: 0, decided: false, winner: null, tie: false, deadlocked: false });

    const majority = tally(3, [v(1, 0), v(2, 0), v(3, 1), v(4, 0)], 5);
    expect(majority).toMatchObject({ counts: [3, 1, 0], leader: 0, decided: true, winner: 0 });
  });

  it("half is not a majority, but everyone voting decides", () => {
    const half = tally(3, [v(1, 0), v(2, 0)], 4);
    expect(half.decided).toBe(false);
    const everyone = tally(3, [v(1, 0), v(2, 0), v(3, 1), v(4, 2)], 4);
    expect(everyone).toMatchObject({ voters: 4, decided: true, winner: 0 });
  });

  it("counts each person once per option, latest state wins", () => {
    const t = tally(3, [v(1, 0), v(1, 0), v(1, 0), v(2, 1)], 4);
    expect(t.counts).toEqual([1, 1, 0]);

    const changed = tally(3, [v(1, 0), v(1, 0, false), v(1, 2)], 4);
    expect(changed.counts).toEqual([0, 0, 1]);
    expect(changed.voters).toBe(1);
  });

  it("a fully deselected person is no longer a voter", () => {
    const t = tally(3, [v(1, 1), v(1, 1, false)], 3);
    expect(t).toMatchObject({ counts: [0, 0, 0], voters: 0, leader: null, winner: null });
  });

  it("allows multi-select", () => {
    const t = tally(3, [v(1, 0), v(1, 1), v(2, 1), v(3, 2)], 3);
    expect(t.counts).toEqual([1, 2, 1]);
    expect(t.voters).toBe(3);
    expect(t).toMatchObject({ leader: 1, decided: true, winner: 1, tie: false });
  });

  it("a tie with everyone voted is deadlocked, not a win; the leader is the cheapest tied option", () => {
    const votes = [v(1, 0), v(2, 1)];
    const costs = [90_000, 75_000, 80_000];
    expect(tally(3, votes, 2, costs)).toMatchObject({ tie: true, decided: false, deadlocked: true, leader: 1, winner: null });
    expect(tally(3, votes, 2)).toMatchObject({ tie: true, decided: false, deadlocked: true, leader: 0, winner: null });
    expect(tally(3, votes, 4, costs)).toMatchObject({ tie: true, decided: false, deadlocked: false, leader: 1, winner: null });
  });

  it("2–2 in a group of four doesn't lock (the asheville bug); a switch to 3–1 does", () => {
    const costs = [70_000, 80_000];
    const tied = [v(1, 0), v(2, 0), v(3, 1), v(4, 1)];
    expect(tally(2, tied, 4, costs)).toMatchObject({ counts: [2, 2], decided: false, deadlocked: true, leader: 0 });
    expect(tally(2, [...tied, v(4, 1, false), v(4, 0)], 4, costs)).toMatchObject({ counts: [3, 1], decided: true, winner: 0 });
  });

  it("ignores votes for options that don't exist", () => {
    const t = tally(2, [v(1, 5), v(2, -1), v(3, 1)], 3);
    expect(t.counts).toEqual([0, 1]);
    expect(t.voters).toBe(1);
  });
});

describe("text votes against a native poll's titles", () => {
  const titles = ["Medellín (~$835)", "Gatlinburg (~$630)", "Asheville (~$685)"].map((t) => t.split(" (")[0]!);
  it("counts a plain place name the same as tapping it", () => {
    expect(parseVote("Gatlinburg", titles)).toBe(1);
    expect(parseVote("medellin", titles)).toBe(0);
  });
  it("doesn't read 'we all voted' as a vote", () => {
    expect(parseVote("we all voted", titles)).toBeNull();
    expect(parseVote("voted", titles)).toBeNull();
  });
});

describe("reconcileVotes (provider voter list is the truth for native votes)", () => {
  const now = new Date("2026-10-10T22:40:00Z");
  const t = (min: number) => new Date(now.getTime() - min * 60_000);
  const stored = (personId: number, optionIdx: number, source: string, min: number, selected = true): StoredVote => ({ personId, optionIdx, selected, source, votedAt: t(min) });
  const apply = (rows: StoredVote[], changes: VoteChange[]): StoredVote[] => {
    const out = new Map(rows.map((r) => [`${r.personId}:${r.optionIdx}`, r]));
    for (const c of changes) out.set(`${c.personId}:${c.optionIdx}`, { personId: c.personId, optionIdx: c.optionIdx, selected: c.selected, source: c.source, votedAt: c.at });
    return [...out.values()];
  };

  it("adds votes whose webhooks were lost (the real 4-of-4 case) and is idempotent", () => {
    const provider = [1, 2, 3, 4].map((personId) => ({ personId, optionIdx: 1, votedAt: t(9) }));
    const changes = reconcileVotes([], provider, { now });
    expect(changes).toHaveLength(4);
    const after = apply([], changes);
    expect(tally(3, after, 4).winner).toBe(1);
    expect(reconcileVotes(after, provider, { now })).toEqual([]);
  });

  it("doesn't double-count someone who voted by text and in the poll for the same place", () => {
    const rows = [stored(1, 1, "text", 5)];
    expect(reconcileVotes(rows, [{ personId: 1, optionIdx: 1, votedAt: t(4) }], { now })).toEqual([]);
    expect(tally(3, rows, 4).counts).toEqual([0, 1, 0]);
  });

  it("drops an older text pick for another option once the person voted natively", () => {
    const rows = [stored(1, 0, "text", 8)];
    const changes = reconcileVotes(rows, [{ personId: 1, optionIdx: 1, votedAt: t(4) }], { now });
    const after = apply(rows, changes);
    expect(tally(3, after, 4).counts).toEqual([0, 1, 0]);
    expect(tally(3, after, 4).voters).toBe(1);
  });

  it("keeps a newer text pick over a stale native vote it replaced", () => {
    // Native A at -9m, then texted "B" at -2m (single-choice turned A off locally).
    const rows = [stored(1, 0, "native", 2, false), stored(1, 1, "text", 2)];
    expect(reconcileVotes(rows, [{ personId: 1, optionIdx: 0, votedAt: t(9) }], { now })).toEqual([]);
  });

  it("takes back native votes the provider no longer lists, but not fresh ones (the API can lag the webhook)", () => {
    const rows = [stored(1, 0, "native", 10), stored(2, 0, "native", 0.2)];
    const changes = reconcileVotes(rows, [], { now });
    expect(changes).toEqual([{ personId: 1, optionIdx: 0, selected: false, source: "native", at: now }]);
  });

  it("leaves text and tapback votes from people who never touched the poll alone", () => {
    const rows = [stored(5, 2, "text", 30), stored(6, 2, "tapback", 30)];
    expect(reconcileVotes(rows, [{ personId: 1, optionIdx: 1, votedAt: t(1) }], { now })).toHaveLength(1);
  });
});
