import { describe, expect, it } from "vitest";
import { MIN_SIMILARITY, recencyFactor, rerank, type Candidate } from "../../src/memory/retrieve.ts";

const NOW = new Date("2026-10-31T19:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const cand = (id: number, similarity: number, ageDays: number, kind: Candidate["kind"] = "message"): Candidate => ({
  id,
  kind,
  content: `chunk ${id}`,
  createdAt: daysAgo(ageDays),
  similarity,
});

describe("memory rerank", () => {
  it("decays with age: 1.0 fresh, 0.85 + 0.15/e at 14 days, floor 0.85", () => {
    expect(recencyFactor(0)).toBe(1);
    expect(recencyFactor(14)).toBeCloseTo(0.85 + 0.15 / Math.E, 12);
    expect(recencyFactor(21)).toBeCloseTo(0.85 + 0.15 * Math.exp(-1.5), 12);
    expect(recencyFactor(10_000)).toBeCloseTo(0.85, 12);
    // A chunk "from the future" (clock skew) is treated as fresh, never boosted.
    expect(recencyFactor(-3)).toBe(1);
  });

  it("scores similarity × recency", () => {
    const [hit] = rerank([cand(1, 0.8, 21)], NOW);
    expect(hit!.similarity).toBe(0.8);
    expect(hit!.score).toBeCloseTo(0.8 * (0.85 + 0.15 * Math.exp(-1.5)), 12);
  });

  it("drops chunks under the similarity threshold and non-finite similarities", () => {
    const hits = rerank([cand(1, MIN_SIMILARITY - 0.001, 0), cand(2, MIN_SIMILARITY, 0), cand(3, Number.NaN, 0), cand(4, 0.9, 400)], NOW);
    expect(hits.map((h) => h.id)).toEqual([4, 2]);
  });

  it("orders by score: a clearly better old match beats a weak fresh one; equal similarity goes to the fresher", () => {
    const hits = rerank([cand(1, 0.3, 0), cand(2, 0.7, 60), cand(3, 0.7, 0), cand(4, 0.5, 7)], NOW);
    expect(hits.map((h) => h.id)).toEqual([3, 2, 4, 1]);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
  });

  it("breaks exact ties by recency, then by the later chunk id", () => {
    const sameTime = [cand(5, 0.6, 2), cand(9, 0.6, 2), cand(7, 0.6, 2)];
    expect(rerank(sameTime, NOW).map((h) => h.id)).toEqual([9, 7, 5]);
    // Past the decay's useful range both are at the 0.85 floor: equal scores, newer wins.
    const old = [cand(1, 0.5, 5_000), cand(2, 0.5, 4_000)];
    const hits = rerank(old, NOW);
    expect(hits[0]!.score).toBeCloseTo(hits[1]!.score, 12);
    expect(hits.map((h) => h.id)).toEqual([2, 1]);
  });

  it("respects the limit and leaves the input untouched", () => {
    const input = [cand(1, 0.2, 0), cand(2, 0.9, 0), cand(3, 0.5, 0)];
    const copy = JSON.stringify(input);
    expect(rerank(input, NOW, 2).map((h) => h.id)).toEqual([2, 3]);
    expect(JSON.stringify(input)).toBe(copy);
    expect(rerank([], NOW)).toEqual([]);
  });
});
