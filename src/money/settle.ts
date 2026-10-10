// Adapted from ethanyanghq/scout src/scout/settle_up.py @ 60f567b89916edb908129c868e3dd4be664b0e07
// Original author: Ethan Yang — used and adapted with the author's explicit permission.
// Changes: ported to TypeScript over generic member keys; expenses are payer + share
// maps and settlements are payments; balances validate whole cents and assert a zero
// sum; planTransfers finds the exact minimum number of payments (subset DP over
// zero-sum groups) for up to 12 unsettled members and runs the original greedy matching
// inside each group, falling back to plain greedy beyond 12; output is sorted by member
// order; chat formatting is left to callers.
//
// Who owes whom once the trip's costs are in.

import { type Cents, MoneyError } from "./cents.ts";

export type Expense<K> = { payer: K; shares: ReadonlyMap<K, Cents> };
export type Payment<K> = { from: K; to: K; amountCents: Cents };

// Exact search is 3^n; 12 members is ~0.5M steps.
const EXACT_LIMIT = 12;

/**
 * What each member paid minus what they owe, after settlements, in cents. Positive means
 * the group owes them. A settlement from → to moves `from` toward even (+amount) and
 * `to` down by the same amount. Keys outside `members` are included after them.
 */
export function balances<K>(
  members: readonly K[],
  expenses: readonly Expense<K>[],
  settlements: readonly Payment<K>[],
): Map<K, Cents> {
  const net = new Map<K, Cents>();
  for (const member of members) net.set(member, 0);
  const add = (key: K, cents: Cents) => {
    const next = (net.get(key) ?? 0) + cents;
    if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(next)) {
      throw new MoneyError(`not whole cents: ${cents}`);
    }
    net.set(key, next);
  };

  for (const expense of expenses) {
    let paid = 0;
    for (const share of expense.shares.values()) paid += share;
    add(expense.payer, paid);
    for (const [key, share] of expense.shares) add(key, 0 - share);
  }
  for (const s of settlements) {
    if (s.amountCents < 0) throw new MoneyError(`a payment can't be negative: ${s.amountCents}`);
    add(s.from, s.amountCents);
    add(s.to, 0 - s.amountCents);
  }

  assertZeroSum(net);
  return net;
}

/**
 * The fewest payments that bring everyone's balance to zero. The minimum is the number
 * of unsettled members minus the most disjoint zero-sum groups they split into; each
 * group then settles in (size - 1) payments by greedy matching. Exact for up to 12
 * unsettled members, greedy beyond. Ties follow `members` order; output is sorted by
 * (from, to) in that order.
 */
export function planTransfers<K>(members: readonly K[], net: ReadonlyMap<K, Cents>): Payment<K>[] {
  const order = memberOrder(members, net);
  assertZeroSum(net);
  const unsettled = order.filter((key) => (net.get(key) ?? 0) !== 0);
  if (unsettled.length > EXACT_LIMIT) return greedyTransfers(members, net);

  const values = unsettled.map((key) => net.get(key) ?? 0);
  const payments = zeroSumGroups(values).flatMap((group) => {
    const keys = group.map((i) => unsettled[i]!);
    return matchGreedily(keys, keys.map((key) => net.get(key) ?? 0));
  });
  return sortPayments(payments, order);
}

/**
 * Repeatedly matches whoever owes the most with whoever is owed the most. At most one
 * payment fewer than the number of unsettled members, but not always the fewest.
 */
export function greedyTransfers<K>(members: readonly K[], net: ReadonlyMap<K, Cents>): Payment<K>[] {
  const order = memberOrder(members, net);
  assertZeroSum(net);
  return sortPayments(
    matchGreedily(
      order,
      order.map((key) => net.get(key) ?? 0),
    ),
    order,
  );
}

function matchGreedily<K>(keys: readonly K[], start: readonly Cents[]): Payment<K>[] {
  const left = [...start];
  const payments: Payment<K>[] = [];
  for (;;) {
    // Strict comparisons keep the earliest member on ties, so plans are stable.
    let debtor = 0;
    let creditor = 0;
    for (let i = 1; i < left.length; i++) {
      if (left[i]! < left[debtor]!) debtor = i;
      if (left[i]! > left[creditor]!) creditor = i;
    }
    // Balances sum to zero, so nobody owing means everyone's even.
    if (left.length === 0 || left[debtor]! >= 0) return payments;
    const amount = Math.min(-left[debtor]!, left[creditor]!);
    payments.push({ from: keys[debtor]!, to: keys[creditor]!, amountCents: amount });
    left[debtor]! += amount;
    left[creditor]! -= amount;
  }
}

/**
 * Partitions indices of `values` (which sum to zero, none zero) into the largest number
 * of zero-sum groups. best[mask] is that count for a zero-sum mask; each group is chosen
 * to contain the mask's lowest member, so every partition is considered once.
 */
function zeroSumGroups(values: readonly Cents[]): number[][] {
  const n = values.length;
  const sums = new Float64Array(1 << n); // exact: integer sums stay under 2^53
  for (let mask = 1; mask < 1 << n; mask++) {
    const low = mask & -mask;
    sums[mask] = sums[mask ^ low]! + values[31 - Math.clz32(low)]!;
  }
  const best = new Int8Array(1 << n).fill(-1);
  const choice = new Int32Array(1 << n);

  const solve = (mask: number): number => {
    if (mask === 0) return 0;
    if (best[mask]! >= 0) return best[mask]!;
    const low = mask & -mask;
    const rest = mask ^ low;
    let top = -1;
    // Submasks of `rest` in increasing order, so smaller groups of earlier members win ties.
    let sub = 0;
    do {
      const group = sub | low;
      if (sums[group] === 0) {
        const count = 1 + solve(mask ^ group);
        if (count > top) {
          top = count;
          choice[mask] = group;
        }
      }
      sub = (sub - rest) & rest;
    } while (sub !== 0);
    best[mask] = top;
    return top;
  };

  const groups: number[][] = [];
  let mask = (1 << n) - 1;
  solve(mask);
  while (mask !== 0) {
    const group = choice[mask]!;
    const members: number[] = [];
    for (let i = 0; i < n; i++) if (group & (1 << i)) members.push(i);
    groups.push(members);
    mask ^= group;
  }
  return groups;
}

function memberOrder<K>(members: readonly K[], net: ReadonlyMap<K, Cents>): K[] {
  const order = [...new Set(members)];
  const known = new Set(order);
  for (const key of net.keys()) if (!known.has(key)) order.push(key);
  return order;
}

function sortPayments<K>(payments: Payment<K>[], order: readonly K[]): Payment<K>[] {
  const rank = new Map(order.map((key, i) => [key, i]));
  const at = (key: K) => rank.get(key) ?? order.length;
  return payments.sort((a, b) => at(a.from) - at(b.from) || at(a.to) - at(b.to));
}

function assertZeroSum<K>(net: ReadonlyMap<K, Cents>): void {
  let sum = 0;
  for (const cents of net.values()) {
    if (!Number.isSafeInteger(cents)) throw new MoneyError(`not whole cents: ${cents}`);
    sum += cents;
  }
  if (sum !== 0) throw new MoneyError(`balances must sum to zero, got ${sum}`);
}
