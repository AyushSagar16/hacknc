// Vote parsing ported from ethanyanghq/scout tests/test_polls.py (with the author's permission),
// plus Atlas's tally rules: latest state per person, multi-select, majority-or-everyone, cost ties.
import { describe, expect, it } from "vitest";
import { parseVote, tally, type VoteEvent } from "../../src/trips/votes.ts";

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
    expect(tally(3, [], 4)).toEqual({ counts: [0, 0, 0], voters: 0, leader: null, decided: false, winner: null, tie: false });
  });

  it("most votes leads; a strict majority of the group decides", () => {
    const early = tally(3, [v(1, 0), v(2, 0), v(3, 1)], 5);
    expect(early).toMatchObject({ counts: [2, 1, 0], voters: 3, leader: 0, decided: false, winner: null, tie: false });

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

  it("ties go to the cheapest option, else the lowest index", () => {
    const votes = [v(1, 0), v(2, 1)];
    const costs = [90_000, 75_000, 80_000];
    expect(tally(3, votes, 2, costs)).toMatchObject({ tie: true, decided: true, leader: 1, winner: 1 });
    expect(tally(3, votes, 2)).toMatchObject({ tie: true, decided: true, leader: 0, winner: 0 });
    expect(tally(3, votes, 4, costs)).toMatchObject({ tie: true, decided: false, leader: 1, winner: null });
  });

  it("ignores votes for options that don't exist", () => {
    const t = tally(2, [v(1, 5), v(2, -1), v(3, 1)], 3);
    expect(t.counts).toEqual([0, 1]);
    expect(t.voters).toBe(1);
  });
});
