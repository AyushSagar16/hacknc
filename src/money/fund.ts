// Trip-fund arithmetic, pure and exact to the cent:
//   - each person's share of what the fund pays for (the stay plus anything marked shared),
//   - the combined settle-up at the end of the trip: the fund and the tab squared in one list.
//
// Combined settle-up, per person p:
//   fund position  = contributed_p − refunded_p − share of fund spend_p
//   tab position   = paid for others − others paid for p (the expense ledger, after settlements)
//   net_p          = fund position + tab position
// A leftover (the fund holds more than it spent) is refunded pro-rata to what each person put
// in, before anything else, which brings the fund to zero. A shortfall (it spent, or committed
// to, more than it holds) makes the fund a creditor: it joins the transfer list as one more party
// and the people who are behind pay into it. One minimal-transfer list covers everything.
import { type Cents, MoneyError } from "./cents.ts";
import { allocate, splitEvenly } from "./split.ts";
import { planTransfers, type Payment } from "./settle.ts";

/** The fund as a party in the settle-up (person ids are positive). */
export const FUND = -1;

export interface FundItem {
  amountCents: Cents;
  /** Who shares it; null/empty = everyone in `members`. */
  sharedBy?: readonly number[] | null;
}

/**
 * What each member owes the fund. "even": the total in equal shares. "by_cost" (the default
 * column value): each item split among the people it's for, so an item only some of the group
 * wanted is only on them; with every item shared by everyone this is equal shares too.
 * Uneven cents go to the earliest members, so the shares always add up to the target.
 */
export function fundShares(items: readonly FundItem[], members: readonly number[], mode: "even" | "by_cost" = "by_cost"): Map<number, Cents> {
  const out = new Map<number, Cents>(members.map((m) => [m, 0]));
  if (members.length === 0) return out;
  const total = items.reduce((a, i) => a + i.amountCents, 0);
  if (mode === "even") return total > 0 ? splitEvenly(total, members) : out;
  for (const item of items) {
    const among = (item.sharedBy?.length ? item.sharedBy.filter((id) => out.has(id)) : members) as number[];
    const split = splitEvenly(item.amountCents, among.length ? among : [...members]);
    for (const [id, c] of split) out.set(id, (out.get(id) ?? 0) + c);
  }
  return out;
}

/** `amount` divided in proportion to `weights` (largest remainder); everyone with weight 0 gets 0. */
export function proRata(amount: Cents, weights: ReadonlyMap<number, Cents>): Map<number, Cents> {
  const positive = [...weights].filter(([, w]) => w > 0);
  if (amount <= 0 || positive.length === 0) return new Map([...weights.keys()].map((k) => [k, 0]));
  const shares = allocate(amount, positive);
  return new Map([...weights.keys()].map((k) => [k, shares.get(k) ?? 0]));
}

export interface CombinedInput {
  members: readonly number[];
  /** Done contributions per person (into the fund), incl. earlier settle-up payments into it. */
  contributed: ReadonlyMap<number, Cents>;
  /** Refunds already paid back per person (out of the fund). */
  refunded: ReadonlyMap<number, Cents>;
  /** Each person's share of what the fund pays for (fundShares of the active items). */
  spendShares: ReadonlyMap<number, Cents>;
  /** The tab: positive = the group owes them (src/money/settle.ts balances, after settlements). */
  tab: ReadonlyMap<number, Cents>;
}

export interface CombinedResult {
  /** Leftover to send back now, fund → each person's checking. */
  refunds: Map<number, Cents>;
  leftoverCents: Cents;
  /** What the group still owes the fund (0 when it's covered). */
  shortfallCents: Cents;
  /** Per person: fund position + tab position (after the refunds). */
  net: Map<number, Cents>;
  /** The fewest transfers; `to === FUND` pays into the trip fund. */
  transfers: Payment<number>[];
}

export function combinedSettle(input: CombinedInput): CombinedResult {
  const members = [...new Set([...input.members, ...input.contributed.keys(), ...input.spendShares.keys(), ...input.tab.keys()])];
  const sum = (m: ReadonlyMap<number, Cents>) => [...m.values()].reduce((a, b) => a + b, 0);
  for (const m of [input.contributed, input.refunded, input.spendShares]) for (const c of m.values()) if (!Number.isSafeInteger(c) || c < 0) throw new MoneyError(`not whole cents ≥ 0: ${c}`);
  const held = sum(input.contributed) - sum(input.refunded);
  const spend = sum(input.spendShares);
  const leftoverCents = Math.max(0, held - spend);
  // Pro-rata to what each person still has in the fund.
  const inFund = new Map(members.map((m) => [m, Math.max(0, (input.contributed.get(m) ?? 0) - (input.refunded.get(m) ?? 0))]));
  const refunds = leftoverCents > 0 ? proRata(leftoverCents, inFund) : new Map<number, Cents>();
  const net = new Map<number, Cents>();
  for (const m of members) {
    const fund = (input.contributed.get(m) ?? 0) - (input.refunded.get(m) ?? 0) - (refunds.get(m) ?? 0) - (input.spendShares.get(m) ?? 0);
    net.set(m, fund + (input.tab.get(m) ?? 0));
  }
  const shortfallCents = Math.max(0, spend - held);
  const all = new Map(net);
  if (shortfallCents > 0) all.set(FUND, shortfallCents);
  const transfers = planTransfers([...members, ...(shortfallCents > 0 ? [FUND] : [])], all);
  return { refunds: new Map([...refunds].filter(([, c]) => c > 0)), leftoverCents, shortfallCents, net, transfers };
}
