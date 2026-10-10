// Adapted from ethanyanghq/scout src/scout/expense_split.py @ 60f567b89916edb908129c868e3dd4be664b0e07
// Original author: Ethan Yang — used and adapted with the author's explicit permission.
// Changes: ported to TypeScript over generic member keys with ordered Map results;
// allocate takes ordered [key, weight] pairs, multiplies in BigInt so huge totals stay
// exact, and validates input (MoneyError); `remainderTo` hands leftover cents to the
// payer first; itemized splits reject empty input and negative shares, and fall back to
// an even split when every item was free.
//
// How one expense divides into what each member owes, in whole cents. Every division
// adds up to exactly the amount: no cent is lost or invented.

import { type Cents, MoneyError } from "./cents.ts";

export type SplitItem<K> = { name: string; amountCents: Cents; sharedBy: readonly K[] };

/**
 * Divides `total` in proportion to whole-number `weights`, to the cent (largest
 * remainder). Everyone gets their rounded-down portion, then the cents left over go to
 * whoever lost the most to rounding; ties go to whoever is listed first. A negative
 * total divides the same way, as a reduction.
 */
export function allocate<K>(total: Cents, weights: ReadonlyArray<readonly [K, number]>): Map<K, Cents> {
  assertCents(total, "total");
  const seen = new Set<K>();
  let weightSum = 0n;
  for (const [key, weight] of weights) {
    if (seen.has(key)) throw new MoneyError(`listed twice: ${String(key)}`);
    seen.add(key);
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new MoneyError(`weights must be whole numbers ≥ 0, got ${weight}`);
    }
    weightSum += BigInt(weight);
  }
  if (weightSum <= 0n) throw new MoneyError("there is nobody to divide it among");

  if (total < 0) {
    const shares = allocate(-total, weights);
    for (const [key, cents] of shares) shares.set(key, 0 - cents);
    return shares;
  }

  const big = BigInt(total);
  const shares = new Map<K, Cents>();
  const lost: { key: K; index: number; remainder: bigint }[] = [];
  let given = 0;
  weights.forEach(([key, weight], index) => {
    const product = big * BigInt(weight);
    const portion = Number(product / weightSum);
    shares.set(key, portion);
    given += portion;
    lost.push({ key, index, remainder: product % weightSum });
  });
  lost.sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const { key } of lost.slice(0, total - given)) shares.set(key, (shares.get(key) ?? 0) + 1);
  return shares;
}

/**
 * Splits `total` evenly. Leftover cents go to `remainderTo` first when they're in the
 * split (pass the payer, so nobody owes them an extra cent), then to the earliest members.
 */
export function splitEvenly<K>(total: Cents, members: readonly K[], opts: { remainderTo?: K } = {}): Map<K, Cents> {
  const unique = [...new Set(members)];
  const shares = allocate(
    total,
    payerFirst(unique, opts.remainderTo).map((key) => [key, 1] as const),
  );
  return inOrder(shares, unique);
}

/**
 * Each item divides evenly among the members who shared it. What the items don't add up
 * to (tax, tip, fees, or a discount) divides in proportion to what each member's items
 * cost, so someone who skipped the steak doesn't pay tax on it.
 */
export function splitByItems<K>(
  items: readonly SplitItem<K>[],
  total: Cents,
  opts: { remainderTo?: K } = {},
): Map<K, Cents> {
  if (items.length === 0) throw new MoneyError("an itemized split needs at least one item");
  assertCents(total, "total");

  const owed = new Map<K, Cents>();
  let itemsTotal = 0;
  for (const item of items) {
    assertCents(item.amountCents, `"${item.name}"`);
    if (item.sharedBy.length === 0) throw new MoneyError(`nobody shared "${item.name}"`);
    for (const [key, cents] of splitEvenly(item.amountCents, item.sharedBy, opts)) {
      owed.set(key, (owed.get(key) ?? 0) + cents);
    }
    itemsTotal += item.amountCents;
  }

  const unlisted = total - itemsTotal;
  if (unlisted !== 0) {
    // If every item was free there's nothing to be proportional to; split the rest evenly.
    const free = [...owed.values()].every((cents) => cents === 0);
    const people = payerFirst([...owed.keys()], opts.remainderTo);
    const extra = allocate(
      unlisted,
      people.map((key) => [key, free ? 1 : (owed.get(key) ?? 0)] as const),
    );
    for (const [key, cents] of extra) owed.set(key, (owed.get(key) ?? 0) + cents);
  }

  for (const [key, cents] of owed) {
    if (cents < 0) throw new MoneyError(`${String(key)} would end up owing ${cents} cents`);
  }
  return owed;
}

function assertCents(value: Cents, what: string): void {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`${what} must be whole cents, got ${value}`);
}

function payerFirst<K>(keys: readonly K[], payer: K | undefined): K[] {
  if (payer === undefined || !keys.includes(payer)) return [...keys];
  return [payer, ...keys.filter((key) => key !== payer)];
}

function inOrder<K>(shares: ReadonlyMap<K, Cents>, order: readonly K[]): Map<K, Cents> {
  return new Map(order.map((key) => [key, shares.get(key) ?? 0]));
}
