// Trip budget engine. Replays a person's (Nessie) ledger into one number plus the three
// chat lines that explain it:
//   1. monthly free = median paychecks - recurring bills - median discretionary purchases
//   2. suggested    = monthly free x clamp(months until trip, 1, 6) x safe fraction
//   3. budget       = clamp(suggested, 0, liquid balance - one month of bills), floored to $25
import { daysBetween } from "../clock.ts";

type Cents = number;

export type AccountType = "Checking" | "Savings" | "Credit Card";
export type TxnKind = "deposit" | "purchase" | "withdrawal" | "transfer_out" | "transfer_in" | "bill_payment";
export type BillStatus = "recurring" | "pending" | "completed" | "cancelled";

export interface LedgerAccount {
  id: string;
  type: AccountType;
  openingBalanceCents: Cents;
}

export interface LedgerTxn {
  accountId: string;
  kind: TxnKind;
  date: string;
  amountCents: Cents;
  description: string;
  category?: string;
}

export interface RecurringBill {
  accountId: string;
  payee: string;
  amountCents: Cents;
  recurringDay: number | null;
  status: BillStatus;
  description?: string;
}

export interface BudgetInput {
  asOf: string;
  tripStart?: string | null;
  accounts: LedgerAccount[];
  txns: LedgerTxn[];
  bills: RecurringBill[];
  safeFraction?: number;
  windowMonths?: number;
}

export interface BudgetResult {
  budgetCents: Cents;
  suggestedCents: Cents;
  capCents: Cents;
  monthlyIncomeCents: Cents;
  monthlyBillsCents: Cents;
  monthlyDiscretionaryCents: Cents;
  monthlyFreeCents: Cents;
  monthsUntilTrip: number;
  liquidBalanceCents: Cents;
  safeFraction: number;
  explanation: [string, string, string];
  window: { start: string; end: string };
  counts: { paychecks: number; purchases: number; bills: number };
}

export interface PoolEntry {
  personId: number;
  budgetCents: Cents;
  visibility: "public" | "private";
}

export interface PoolSummary {
  minCents: Cents;
  maxCents: Cents;
  ceilingCents: Cents;
  count: number;
  anyPrivate: boolean;
  canShowRange: boolean;
}

export const ATLAS_PREFIX = "[atlas]";
export const PAYCHECK_PATTERN = /payroll|paycheck|salary|direct dep/i;

const ROUND_TO: Cents = 2500;
const MAX_MONTHS = 6;
const DAYS_PER_MONTH = 30.44;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for objects Atlas itself wrote to Nessie (trip purchases, installment bills, settle-ups). */
export function isAtlasObject(text: string | undefined | null): boolean {
  return (text ?? "").trimStart().toLowerCase().startsWith(ATLAS_PREFIX);
}

export function computeBudget(input: BudgetInput): BudgetResult {
  const { asOf } = input;
  if (!ISO_DAY.test(asOf)) throw new RangeError(`asOf must be YYYY-MM-DD, got "${asOf}"`);
  const safeFraction = clamp(input.safeFraction ?? 0.5, 0, 1);
  const months = windowMonthsFor(input);
  const inWindow = new Set(months);
  const window = { start: `${months[0]!}-01`, end: monthEnd(months.at(-1)!) };

  // Atlas's own objects never shape the medians: they are the trip, not the person's habits.
  const income = new Map(months.map((m) => [m, 0]));
  const spend = new Map(months.map((m) => [m, 0]));
  const counts = { paychecks: 0, purchases: 0, bills: 0 };
  for (const t of input.txns) {
    const month = t.date.slice(0, 7);
    if (!inWindow.has(month) || isAtlasObject(t.description)) continue;
    if (t.kind === "deposit" && PAYCHECK_PATTERN.test(t.description)) {
      income.set(month, income.get(month)! + Math.abs(t.amountCents));
      counts.paychecks++;
    } else if (t.kind === "purchase") {
      spend.set(month, spend.get(month)! + Math.abs(t.amountCents));
      counts.purchases++;
    }
  }

  let monthlyBillsCents = 0;
  for (const b of input.bills) {
    if (b.status !== "recurring" || isAtlasObject(b.description) || isAtlasObject(b.payee)) continue;
    monthlyBillsCents += Math.abs(b.amountCents);
    counts.bills++;
  }

  const monthlyIncomeCents = Math.round(median([...income.values()]));
  const monthlyDiscretionaryCents = Math.round(median([...spend.values()]));
  const monthlyFreeCents = monthlyIncomeCents - monthlyBillsCents - monthlyDiscretionaryCents;

  const rawMonths = input.tripStart ? Math.floor(daysBetween(asOf, input.tripStart) / DAYS_PER_MONTH) : null;
  const monthsUntilTrip = clamp(rawMonths ?? 1, 1, MAX_MONTHS);
  const suggestedCents = Math.round(monthlyFreeCents * monthsUntilTrip * safeFraction);

  const liquidBalanceCents = replayLiquidBalance(input);
  const capCents = liquidBalanceCents - monthlyBillsCents;
  const clamped = Math.max(0, Math.min(suggestedCents, capCents));
  const budgetCents = Math.floor(clamped / ROUND_TO) * ROUND_TO;

  const explanation = explain({
    windowCount: months.length,
    paychecks: counts.paychecks,
    income: monthlyIncomeCents,
    bills: monthlyBillsCents,
    discretionary: monthlyDiscretionaryCents,
    free: monthlyFreeCents,
    rawMonths,
    months: monthsUntilTrip,
    safeFraction,
    suggested: suggestedCents,
    liquid: liquidBalanceCents,
    cap: capCents,
    budget: budgetCents,
    rounded: budgetCents < clamped,
  });

  return {
    budgetCents,
    suggestedCents,
    capCents,
    monthlyIncomeCents,
    monthlyBillsCents,
    monthlyDiscretionaryCents,
    monthlyFreeCents,
    monthsUntilTrip,
    liquidBalanceCents,
    safeFraction,
    explanation,
    window,
    counts,
  };
}

/**
 * Group view of everyone's budgets. The ceiling is the smallest budget (the trip has to
 * work for everyone). A range is only shown when it cannot reveal a private number: with
 * two people and one private budget, the range plus the public budget gives it away.
 */
export function poolBudgets(entries: PoolEntry[]): PoolSummary {
  const count = entries.length;
  const anyPrivate = entries.some((e) => e.visibility === "private");
  if (count === 0) return { minCents: 0, maxCents: 0, ceilingCents: 0, count, anyPrivate, canShowRange: false };
  const values = entries.map((e) => e.budgetCents);
  const minCents = Math.min(...values);
  const maxCents = Math.max(...values);
  const canShowRange = count >= 2 && !(count === 2 && anyPrivate);
  return { minCents, maxCents, ceilingCents: minCents, count, anyPrivate, canShowRange };
}

// Liquid = Checking + Savings, replayed from opening balances because Nessie never updates
// balances itself. Unlike the medians, Atlas's own transactions ARE replayed here: a trip
// purchase or a settle-up transfer really moved money. Credit card activity never touches it.
function replayLiquidBalance(input: BudgetInput): Cents {
  const liquid = new Set(input.accounts.filter((a) => a.type !== "Credit Card").map((a) => a.id));
  let balance = input.accounts.filter((a) => liquid.has(a.id)).reduce((sum, a) => sum + a.openingBalanceCents, 0);
  for (const t of input.txns) {
    if (!liquid.has(t.accountId) || t.date > input.asOf) continue;
    const amount = Math.abs(t.amountCents);
    balance += t.kind === "deposit" || t.kind === "transfer_in" ? amount : -amount;
  }
  return balance;
}

// The last `windowMonths` complete calendar months before asOf's month, trimmed forward when
// the ledger starts later (a mostly-empty month would drag every median to zero). A first
// month whose earliest transaction is after the 7th is treated as partial and skipped.
function windowMonthsFor(input: BudgetInput): string[] {
  const asOfMonth = input.asOf.slice(0, 7);
  const size = Math.max(1, Math.floor(input.windowMonths ?? 6));
  const last = shiftMonth(asOfMonth, -1);
  let first = shiftMonth(asOfMonth, -size);
  let earliest: string | null = null;
  for (const t of input.txns) {
    if (t.date > input.asOf || isAtlasObject(t.description)) continue;
    if (earliest === null || t.date < earliest) earliest = t.date;
  }
  if (earliest) {
    const dataFirst = Number(earliest.slice(8, 10)) > 7 ? shiftMonth(earliest.slice(0, 7), 1) : earliest.slice(0, 7);
    if (dataFirst > first && dataFirst <= last) first = dataFirst;
  }
  const out: string[] = [];
  for (let m = first; m <= last; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

interface ExplainInput {
  windowCount: number;
  paychecks: number;
  income: Cents;
  bills: Cents;
  discretionary: Cents;
  free: Cents;
  rawMonths: number | null;
  months: number;
  safeFraction: number;
  suggested: Cents;
  liquid: Cents;
  cap: Cents;
  budget: Cents;
  rounded: boolean;
}

function explain(x: ExplainInput): [string, string, string] {
  const [inc, bills, disc, free] = [x.income, x.bills, x.discretionary, x.free].map(wholeUsd);
  const span = x.windowCount === 1 ? "month" : `${x.windowCount} months`;
  const share = x.safeFraction === 0.5 ? "half" : `${Math.round(x.safeFraction * 100)}%`;

  const line1 =
    x.paychecks === 0
      ? `i don't see any paychecks in your last ${span}, and recurring bills take ${bills}/mo`
      : x.free > 0
        ? `you typically bring in ${inc}/mo and recurring bills take ${bills}; after ~${disc}/mo of everyday spending, about ${free}/mo is free`
        : `you typically bring in ${inc}/mo, but recurring bills (${bills}) and everyday spending (~${disc}/mo) use all of it`;

  if (x.suggested <= 0) {
    return [line1, "with nothing left over each month, there's no safe amount to set aside yet", "so your budget is $0 for now; you can always set your own number"];
  }

  const suggested = wholeUsd(x.suggested);
  const plural = x.months === 1 ? "month" : "months";
  const line2 =
    x.rawMonths === null
      ? `there's no trip date yet, so i'm counting one month: ${share} of that is ${suggested}`
      : x.rawMonths < 1
        ? `the trip is less than a month away, so setting aside ${share} of one month's free money gives ${suggested}`
        : x.rawMonths > MAX_MONTHS
          ? `the trip is ${x.rawMonths} months away but i only count ${MAX_MONTHS}, so setting aside ${share} of that each month gives ${suggested}`
          : `the trip is about ${x.months} ${plural} away, and setting aside ${share} of that each month gives ${suggested}`;

  const liquid = wholeUsd(x.liquid);
  const roundNote = x.rounded ? " (rounded down to the nearest $25)" : "";
  const line3 =
    x.cap <= 0
      ? `but your checking + savings (${liquid}) only just covers next month's bills (${bills}), so i'd hold off: $0 for now`
      : x.suggested > x.cap
        ? `but keeping next month's bills covered from your checking + savings (${liquid}) caps it at ${wholeUsd(x.cap)}, so your budget is ${formatUsd(x.budget)}${roundNote}`
        : `your checking + savings (${liquid}) still covers next month's bills after that, so your budget is ${formatUsd(x.budget)}${roundNote}`;

  return [line1, line2, line3];
}

/** "$1,240" for whole dollars, "$236.50" otherwise. */
function formatUsd(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = abs % 100;
  return `${sign}$${dollars}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

function wholeUsd(cents: Cents): string {
  return formatUsd(Math.round(cents / 100) * 100);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function shiftMonth(ym: string, delta: number): string {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function monthEnd(ym: string): string {
  const next = shiftMonth(ym, 1);
  const d = new Date(`${next}-01T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
