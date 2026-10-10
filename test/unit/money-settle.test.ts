import { describe, expect, it } from "vitest";
import { type Cents, MoneyError } from "../../src/money/cents.ts";
import { balances, greedyTransfers, planTransfers, type Expense, type Payment } from "../../src/money/settle.ts";
import { allocate, splitByItems, splitEvenly } from "../../src/money/split.ts";

const MAYA = "Maya";
const LEO = "Leo";
const JORDAN = "Jordan";
const PRIYA = "Priya";
const GROUP = [MAYA, LEO, JORDAN, PRIYA];

const evenly = (payer: string, cents: Cents, among: readonly string[] = GROUP): Expense<string> => ({
  payer,
  shares: splitEvenly(cents, among),
});
const summarize = (payments: Payment<string>[]) => payments.map((p) => [p.from, p.to, p.amountCents]);
const plan = (members: string[], expenses: Expense<string>[], settlements: Payment<string>[] = []) =>
  planTransfers(members, balances(members, expenses, settlements));

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

/**
 * Exhaustive search for the fewest transfers, independent of planTransfers' subset DP:
 * the first unsettled person settles in full with each possible counterpart in turn.
 */
function bruteMinimum(values: readonly Cents[]): number {
  const b = values.filter((v) => v !== 0);
  const search = (start: number): number => {
    let i = start;
    while (i < b.length && b[i] === 0) i++;
    if (i === b.length) return 0;
    let best = Infinity;
    for (let j = i + 1; j < b.length; j++) {
      if (Math.sign(b[j]!) === -Math.sign(b[i]!)) {
        b[j]! += b[i]!;
        best = Math.min(best, 1 + search(i + 1));
        b[j]! -= b[i]!;
      }
    }
    return best;
  };
  return search(0);
}

function applyPayments<K>(net: ReadonlyMap<K, Cents>, payments: readonly Payment<K>[]): Map<K, Cents> {
  const left = new Map(net);
  for (const p of payments) {
    left.set(p.from, (left.get(p.from) ?? 0) + p.amountCents);
    left.set(p.to, (left.get(p.to) ?? 0) - p.amountCents);
  }
  return left;
}

function expectSettles<K>(net: ReadonlyMap<K, Cents>, payments: readonly Payment<K>[]): void {
  for (const p of payments) {
    expect(p.amountCents).toBeGreaterThan(0);
    expect(Number.isSafeInteger(p.amountCents)).toBe(true);
    expect(p.from).not.toBe(p.to);
  }
  for (const cents of applyPayments(net, payments).values()) expect(cents).toBe(0);
}

/** The PRD's sample journey: $1,600 of shared costs split four ways. */
const springBreak = () => [evenly(LEO, 124_000), evenly(PRIYA, 16_400), evenly(MAYA, 19_600)];

// Ported from scout tests/test_settle_up.py. Output is sorted by member order here, where
// scout listed payments in the order greedy found them.
describe("ported scout cases", () => {
  it("whoever owes most pays whoever is owed most", () => {
    expect(summarize(plan(GROUP, springBreak()))).toEqual([
      [MAYA, LEO, 20_400],
      [JORDAN, LEO, 40_000],
      [PRIYA, LEO, 23_600],
    ]);
  });

  it("settling up takes at most one payment fewer than the group size", () => {
    const payments = plan(GROUP, [evenly(MAYA, 30_000), evenly(LEO, 10_000), evenly(JORDAN, 5_000)]);
    expect(payments.length).toBeLessThanOrEqual(3);
    expect(payments.filter((p) => p.to === MAYA).reduce((a, p) => a + p.amountCents, 0)).toBe(18_750);
  });

  it("leftover cents are shared so nothing is lost", () => {
    // $100 splits into $33.34 + $33.33 + $33.33. Maya covers the extra cent.
    expect(summarize(plan([MAYA, LEO, JORDAN], [evenly(MAYA, 10_000, [MAYA, LEO, JORDAN])]))).toEqual([
      [LEO, MAYA, 3_333],
      [JORDAN, MAYA, 3_333],
    ]);
  });

  it("nobody pays when everyone spent the same", () => {
    expect(plan([MAYA, LEO], [evenly(MAYA, 5_000, [MAYA, LEO]), evenly(LEO, 5_000, [MAYA, LEO])])).toEqual([]);
  });

  it("payments already made drop out of the plan", () => {
    const settled = [{ from: MAYA, to: LEO, amountCents: 20_400 }];
    expect(summarize(plan(GROUP, springBreak(), settled))).toEqual([
      [JORDAN, LEO, 40_000],
      [PRIYA, LEO, 23_600],
    ]);
  });

  it("a cost only some people shared is owed only by them", () => {
    // Jordan and Priya weren't on the kayaks, so they owe nothing.
    expect(summarize(plan(GROUP, [evenly(MAYA, 19_600, [MAYA, LEO])]))).toEqual([[LEO, MAYA, 9_800]]);
  });
});

describe("balances", () => {
  it("is what each member paid minus what they owe", () => {
    expect([...balances(GROUP, springBreak(), [])]).toEqual([
      [MAYA, -20_400],
      [LEO, 84_000],
      [JORDAN, -40_000],
      [PRIYA, -23_600],
    ]);
  });

  it("moves the payer of a settlement toward even", () => {
    const net = balances(GROUP, springBreak(), [{ from: JORDAN, to: LEO, amountCents: 10_000 }]);
    expect(net.get(JORDAN)).toBe(-30_000);
    expect(net.get(LEO)).toBe(74_000);
  });

  it("starts everyone at zero and includes people outside the member list", () => {
    const net = balances([MAYA, LEO], [{ payer: "Sam", shares: new Map([[MAYA, 500], ["Ana", 500]]) }], []);
    expect([...net]).toEqual([
      [MAYA, -500],
      [LEO, 0],
      ["Sam", 1_000],
      ["Ana", -500],
    ]);
  });

  it("never reports -0", () => {
    for (const c of balances([MAYA, LEO], [evenly(MAYA, 0, [MAYA, LEO])], []).values()) {
      expect(Object.is(c, 0)).toBe(true);
    }
  });

  it("rejects amounts that aren't whole cents", () => {
    expect(() => balances(GROUP, [{ payer: MAYA, shares: new Map([[LEO, 1.5]]) }], [])).toThrow(MoneyError);
    expect(() => balances(GROUP, [], [{ from: MAYA, to: LEO, amountCents: -100 }])).toThrow(MoneyError);
  });
});

describe("planTransfers", () => {
  const net = (pairs: [string, Cents][]) => new Map(pairs);

  it("plans nothing when everyone is even", () => {
    expect(planTransfers(GROUP, net([[MAYA, 0], [LEO, 0]]))).toEqual([]);
    expect(planTransfers([], new Map())).toEqual([]);
  });

  it("settles two people in one payment", () => {
    expect(planTransfers([MAYA, LEO], net([[MAYA, -1_250], [LEO, 1_250]]))).toEqual([
      { from: MAYA, to: LEO, amountCents: 1_250 },
    ]);
  });

  it("beats greedy when the group splits into zero-sum subgroups", () => {
    const members = ["A", "B", "C", "D", "E"];
    const balancesInCents = net([
      ["A", 600],
      ["B", 400],
      ["C", -400],
      ["D", -300],
      ["E", -300],
    ]);
    const exact = planTransfers(members, balancesInCents);
    const greedy = greedyTransfers(members, balancesInCents);
    // {B, C} settle on their own; {A, D, E} take two payments.
    expect(summarize(exact)).toEqual([
      ["C", "B", 400],
      ["D", "A", 300],
      ["E", "A", 300],
    ]);
    expect(greedy).toHaveLength(4);
    expectSettles(balancesInCents, exact);
    expectSettles(balancesInCents, greedy);
  });

  it("breaks ties by member order and sorts by (from, to)", () => {
    const balancesInCents = net([
      ["A", -100],
      ["B", -100],
      ["C", 100],
      ["D", 100],
    ]);
    expect(summarize(planTransfers(["A", "B", "C", "D"], balancesInCents))).toEqual([
      ["A", "C", 100],
      ["B", "D", 100],
    ]);
    expect(summarize(planTransfers(["D", "C", "B", "A"], balancesInCents))).toEqual([
      ["B", "D", 100],
      ["A", "C", 100],
    ]);
  });

  it("orders keys missing from members after them", () => {
    expect(summarize(planTransfers([MAYA], net([["Sam", -500], [MAYA, 500]])))).toEqual([["Sam", MAYA, 500]]);
  });

  it("rejects balances that don't sum to zero", () => {
    expect(() => planTransfers([MAYA, LEO], net([[MAYA, 100], [LEO, -99]]))).toThrow(MoneyError);
    expect(() => greedyTransfers([MAYA, LEO], net([[MAYA, 100], [LEO, -99]]))).toThrow(MoneyError);
    expect(() => planTransfers([MAYA, LEO], net([[MAYA, 0.5], [LEO, -0.5]]))).toThrow(MoneyError);
  });

  it("solves 12 unsettled members exactly", () => {
    // Six +/- pairs hidden among each other: the minimum is 6 payments.
    const values = [700, -300, 1_100, -700, 300, -1_100, 1_300, -1_700, 1_700, -1_300, 1_900, -1_900];
    const members = values.map((_, i) => `m${i}`);
    const balancesInCents = new Map(members.map((m, i) => [m, values[i]!]));
    const started = performance.now();
    const payments = planTransfers(members, balancesInCents);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(payments).toHaveLength(6);
    expectSettles(balancesInCents, payments);
  });

  it("falls back to greedy past 12 unsettled members", () => {
    const values = [700, -300, 1_100, -700, 300, -1_100, 1_300, -1_700, 1_700, -1_300, 1_900, -1_900, 50, -50];
    const members = values.map((_, i) => `m${i}`);
    const balancesInCents = new Map(members.map((m, i) => [m, values[i]!]));
    const payments = planTransfers(members, balancesInCents);
    expect(payments).toEqual(greedyTransfers(members, balancesInCents));
    expect(payments.length).toBeLessThanOrEqual(13);
    expectSettles(balancesInCents, payments);
  });
});

describe("properties", () => {
  it("random ledgers: shares add up, plans settle everyone, and match the true minimum", () => {
    const rand = mulberry32(0xc0ffee);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    let checkedAgainstBrute = 0;

    for (let run = 0; run < 600; run++) {
      const members = Array.from({ length: 2 + Math.floor(rand() * 8) }, (_, i) => `m${i}`);
      const expenses: Expense<string>[] = [];
      for (let e = 0, count = 1 + Math.floor(rand() * 8); e < count; e++) {
        const payer = pick(members);
        const among = members.filter(() => rand() < 0.6);
        if (among.length === 0) among.push(pick(members));
        // Round-dollar amounts make zero-sum subgroups (and greedy's mistakes) more likely.
        const total = rand() < 0.5 ? (1 + Math.floor(rand() * 200)) * 100 : 1 + Math.floor(rand() * 50_000);
        const mode = rand();
        const shares =
          mode < 0.5
            ? splitEvenly(total, among, { remainderTo: payer })
            : mode < 0.8
              ? allocate(
                  total,
                  among.map((k) => [k, 1 + Math.floor(rand() * 4)] as const),
                )
              : splitByItems(
                  [
                    { name: "a", amountCents: Math.floor(total / 2), sharedBy: among.slice(0, 1) },
                    { name: "b", amountCents: Math.floor(total / 3), sharedBy: among },
                  ],
                  total,
                  { remainderTo: payer },
                );
        expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(total);
        expenses.push({ payer, shares });
      }
      const settlements: Payment<string>[] =
        rand() < 0.3 ? [{ from: pick(members), to: pick(members), amountCents: 1 + Math.floor(rand() * 5_000) }] : [];

      const net = balances(members, expenses, settlements);
      expect([...net.values()].reduce((a, b) => a + b, 0)).toBe(0);
      const exact = planTransfers(members, net);
      const greedy = greedyTransfers(members, net);
      expectSettles(net, exact);
      expectSettles(net, greedy);
      expect(exact.length).toBeLessThanOrEqual(greedy.length);
      const unsettled = [...net.values()].filter((c) => c !== 0).length;
      expect(exact.length).toBeLessThanOrEqual(Math.max(0, unsettled - 1));
      if (members.length <= 7) {
        expect(exact.length).toBe(bruteMinimum([...net.values()]));
        checkedAgainstBrute++;
      }
      // Same input, same plan.
      expect(planTransfers(members, net)).toEqual(exact);
    }
    expect(checkedAgainstBrute).toBeGreaterThan(200);
  });

  it("clustered balances: exact never loses to greedy and often beats it", () => {
    const rand = mulberry32(0xbadc0de);
    let beatGreedy = 0;
    for (let run = 0; run < 400; run++) {
      const values: Cents[] = [];
      const groups = 1 + Math.floor(rand() * 4);
      for (let g = 0; g < groups && values.length < 10; g++) {
        const size = 2 + Math.floor(rand() * 2);
        const group: Cents[] = [];
        while (group.length < size - 1) {
          const v = (Math.floor(rand() * 11) - 5) * 100;
          if (v !== 0) group.push(v);
        }
        const last = -group.reduce((a, b) => a + b, 0);
        if (last === 0) continue;
        values.push(...group, last);
      }
      // Shuffle so subgroups aren't adjacent.
      for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [values[i], values[j]] = [values[j]!, values[i]!];
      }
      const members = values.map((_, i) => `m${i}`);
      const net = new Map(members.map((m, i) => [m, values[i]!]));
      const exact = planTransfers(members, net);
      const greedy = greedyTransfers(members, net);
      expectSettles(net, exact);
      expect(exact.length).toBeLessThanOrEqual(greedy.length);
      if (values.length <= 8) expect(exact.length).toBe(bruteMinimum(values));
      if (exact.length < greedy.length) beatGreedy++;
    }
    expect(beatGreedy).toBeGreaterThan(10);
  });
});
