import { describe, expect, it } from "vitest";
import { MoneyError } from "../../src/money/cents.ts";
import { allocate, splitByItems, splitEvenly, type SplitItem } from "../../src/money/split.ts";

const MAYA = "+15550000001";
const LEO = "+15550000002";
const JORDAN = "+15550000003";
const PRIYA = "+15550000004";

const entries = <K>(m: Map<K, number>) => [...m.entries()];
const sum = (m: Map<unknown, number>) => [...m.values()].reduce((a, b) => a + b, 0);

// Seeded so failures reproduce.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ported from scout tests/test_expense_split.py
describe("ported scout cases", () => {
  it("an even split covers every cent", () => {
    // The extra cent goes to whoever is listed first.
    expect(entries(splitEvenly(10_000, [MAYA, LEO, JORDAN]))).toEqual([
      [MAYA, 3_334],
      [LEO, 3_333],
      [JORDAN, 3_333],
    ]);
  });

  it("only the people named pay for something a few shared", () => {
    expect(entries(splitEvenly(19_600, [MAYA, LEO]))).toEqual([
      [MAYA, 9_800],
      [LEO, 9_800],
    ]);
  });

  it("each item splits among only the people who shared it", () => {
    const items: SplitItem<string>[] = [
      { name: "Steak", amountCents: 4_000, sharedBy: [MAYA] },
      { name: "Nachos", amountCents: 1_200, sharedBy: [MAYA, LEO] },
      { name: "Salad", amountCents: 1_800, sharedBy: [LEO] },
    ];
    expect(entries(splitByItems(items, 7_000))).toEqual([
      [MAYA, 4_600],
      [LEO, 2_400],
    ]);
  });

  it("tax and tip follow what each person had", () => {
    const items: SplitItem<string>[] = [
      { name: "Steak", amountCents: 4_000, sharedBy: [MAYA] },
      { name: "Salad", amountCents: 1_000, sharedBy: [LEO] },
    ];
    // $50 of food, plus $10 of tax and tip: Maya had 80% of the food.
    expect(entries(splitByItems(items, 6_000))).toEqual([
      [MAYA, 4_800],
      [LEO, 1_200],
    ]);
  });

  it("someone who had nothing owes nothing, even for tax and tip", () => {
    const shares = splitByItems([{ name: "Pizza", amountCents: 2_000, sharedBy: [MAYA, LEO] }], 2_400);
    expect(shares.has(PRIYA)).toBe(false);
    expect(entries(shares)).toEqual([
      [MAYA, 1_200],
      [LEO, 1_200],
    ]);
  });

  it("a discount comes off in proportion too", () => {
    const items: SplitItem<string>[] = [
      { name: "Kayak", amountCents: 6_000, sharedBy: [MAYA] },
      { name: "Kayak", amountCents: 4_000, sharedBy: [LEO] },
    ];
    expect(entries(splitByItems(items, 9_000))).toEqual([
      [MAYA, 5_400],
      [LEO, 3_600],
    ]);
  });

  it.each([1, 7, 100, 1_001, 12_345])("odd amounts never lose a cent (%i)", (amount) => {
    const people = [MAYA, LEO, JORDAN, PRIYA];
    const items: SplitItem<string>[] = [
      { name: "A", amountCents: amount, sharedBy: [MAYA, LEO, JORDAN] },
      { name: "B", amountCents: amount, sharedBy: [JORDAN, PRIYA] },
    ];
    expect(sum(splitEvenly(amount, people))).toBe(amount);
    const extras = 37;
    expect(sum(splitByItems(items, 2 * amount + extras))).toBe(2 * amount + extras);
  });
});

describe("allocate", () => {
  it("divides in proportion with the largest remainders rounded up", () => {
    // 66.67 and 33.33: the bigger fraction gets the spare cent.
    expect(entries(allocate(100, [["a", 2], ["b", 1]]))).toEqual([
      ["a", 67],
      ["b", 33],
    ]);
    // 14.29, 28.57, 57.14: one spare cent, and b lost the most (.57) to rounding.
    expect(entries(allocate(100, [["a", 1], ["b", 2], ["c", 4]]))).toEqual([
      ["a", 14],
      ["b", 29],
      ["c", 57],
    ]);
  });

  it("breaks ties toward earlier keys", () => {
    expect(entries(allocate(2, [["a", 1], ["b", 1], ["c", 1]]))).toEqual([
      ["a", 1],
      ["b", 1],
      ["c", 0],
    ]);
  });

  it("mirrors negative totals", () => {
    expect(entries(allocate(-100, [["a", 1], ["b", 1], ["c", 1]]))).toEqual([
      ["a", -34],
      ["b", -33],
      ["c", -33],
    ]);
  });

  it("never gives a spare cent to a zero weight", () => {
    expect(entries(allocate(1, [["a", 0], ["b", 3], ["c", 3]]))).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 0],
    ]);
  });

  it("stays exact for totals and weights whose product passes 2^53", () => {
    const total = 9_000_000_000_000_001;
    expect(Number.isSafeInteger(total)).toBe(true);
    const shares = allocate(total, [["a", 1_000_003], ["b", 999_999]]);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(total);
    expect(shares.get("a")).toBe(4_500_008_999_991_001);
    expect(shares.get("b")).toBe(4_499_991_000_009_000);
  });

  it("keeps zero as zero (never -0)", () => {
    for (const c of allocate(0, [["a", 1], ["b", 1]]).values()) expect(Object.is(c, 0)).toBe(true);
    for (const c of allocate(-1, [["a", 1], ["b", 1]]).values()) expect(c === -1 || Object.is(c, 0)).toBe(true);
  });

  it("rejects input it can't divide", () => {
    expect(() => allocate(100, [])).toThrow(MoneyError);
    expect(() => allocate(100, [["a", 0]])).toThrow(MoneyError);
    expect(() => allocate(100, [["a", -1], ["b", 2]])).toThrow(MoneyError);
    expect(() => allocate(100, [["a", 1.5]])).toThrow(MoneyError);
    expect(() => allocate(100, [["a", 1], ["a", 1]])).toThrow(MoneyError);
    expect(() => allocate(10.5, [["a", 1]])).toThrow(MoneyError);
  });

  it("property: shares sum exactly and sit within a cent of the true proportion", () => {
    const rand = mulberry32(0xa11c);
    for (let run = 0; run < 2_000; run++) {
      const n = 1 + Math.floor(rand() * 9);
      const weights = Array.from({ length: n }, (_, i) => [`k${i}`, Math.floor(rand() * 10_000)] as const);
      if (weights.every(([, w]) => w === 0)) continue;
      const total = Math.floor(rand() * 20_000_001) - 10_000_000;
      const shares = allocate(total, weights);
      expect(sum(shares)).toBe(total);
      const weightSum = weights.reduce((a, [, w]) => a + w, 0);
      for (const [key, w] of weights) {
        expect(Math.abs(shares.get(key)! - (total * w) / weightSum)).toBeLessThan(1);
      }
    }
  });
});

describe("splitEvenly", () => {
  it("gives the spare cent to the payer so nobody owes them extra", () => {
    // Without remainderTo, Maya would owe Jordan $33.34 while Leo owes $33.33.
    expect(entries(splitEvenly(10_000, [MAYA, LEO, JORDAN], { remainderTo: JORDAN }))).toEqual([
      [MAYA, 3_333],
      [LEO, 3_333],
      [JORDAN, 3_334],
    ]);
  });

  it("hands further spare cents to the earliest members after the payer", () => {
    expect(entries(splitEvenly(101, [MAYA, LEO, JORDAN], { remainderTo: LEO }))).toEqual([
      [MAYA, 34],
      [LEO, 34],
      [JORDAN, 33],
    ]);
  });

  it("ignores a payer who isn't in the split", () => {
    expect(entries(splitEvenly(10_000, [MAYA, LEO, JORDAN], { remainderTo: PRIYA }))).toEqual([
      [MAYA, 3_334],
      [LEO, 3_333],
      [JORDAN, 3_333],
    ]);
  });

  it("counts a member listed twice once", () => {
    expect(entries(splitEvenly(100, [MAYA, LEO, MAYA]))).toEqual([
      [MAYA, 50],
      [LEO, 50],
    ]);
  });

  it("needs somebody to split among", () => {
    expect(() => splitEvenly(100, [])).toThrow(MoneyError);
  });
});

describe("splitByItems", () => {
  it("gives item and fee rounding cents to the payer first", () => {
    const items: SplitItem<string>[] = [{ name: "Pizza", amountCents: 1_001, sharedBy: [MAYA, LEO, JORDAN] }];
    // 1001 / 3 = 333.67 each; tax 100 / 3 = 33.33 each.
    expect(entries(splitByItems(items, 1_101, { remainderTo: LEO }))).toEqual([
      [MAYA, 367],
      [LEO, 368],
      [JORDAN, 366],
    ]);
  });

  it("splits fees evenly when every item was free", () => {
    const items: SplitItem<string>[] = [{ name: "Comped dessert", amountCents: 0, sharedBy: [MAYA, LEO] }];
    expect(entries(splitByItems(items, 300))).toEqual([
      [MAYA, 150],
      [LEO, 150],
    ]);
  });

  it("rejects input it can't split", () => {
    expect(() => splitByItems([], 100)).toThrow(MoneyError);
    expect(() => splitByItems([{ name: "Ghost", amountCents: 100, sharedBy: [] }], 100)).toThrow(MoneyError);
    // A discount bigger than the bill would leave shares negative.
    expect(() => splitByItems([{ name: "Kayak", amountCents: 1_000, sharedBy: [MAYA] }], -1)).toThrow(MoneyError);
    expect(() => splitByItems([{ name: "Kayak", amountCents: 10.5, sharedBy: [MAYA] }], 100)).toThrow(MoneyError);
  });

  it("property: random receipts always add up and nobody goes negative", () => {
    const rand = mulberry32(0x5eed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    for (let run = 0; run < 1_000; run++) {
      const people = Array.from({ length: 2 + Math.floor(rand() * 8) }, (_, i) => `p${i}`);
      const items: SplitItem<string>[] = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => ({
        name: `item${i}`,
        amountCents: Math.floor(rand() * 10_000),
        sharedBy: people.filter(() => rand() < 0.5).concat(pick(people)),
      }));
      const itemsTotal = items.reduce((a, item) => a + item.amountCents, 0);
      // Anything from a 100% discount to 30% tax and tip.
      const total = Math.floor(itemsTotal * rand() * 1.3);
      const shares = splitByItems(items, total, { remainderTo: pick(people) });
      expect(sum(shares)).toBe(total);
      for (const c of shares.values()) expect(c).toBeGreaterThanOrEqual(0);
      const sharers = new Set(items.flatMap((item) => item.sharedBy));
      expect(new Set(shares.keys())).toEqual(sharers);
    }
  });
});
