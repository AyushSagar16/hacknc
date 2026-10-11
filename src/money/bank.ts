// A person's own banking, read from their ledger (the same replay the budget engine uses):
// balances per account, where the money went over a window, bills coming up, the latest
// transactions, and the deterministic parsing of "what's my balance" / "move 200 to savings".
// Pure functions: the feature (src/agent/features/banking.ts) does the reads and the writes.
import { addDays, daysBetween } from "../clock.ts";
import { isAtlasObject, type AccountType, type LedgerAccount, type LedgerTxn, type RecurringBill } from "./budget.ts";

type Cents = number;

export interface Ledger {
  accounts: LedgerAccount[];
  txns: LedgerTxn[];
  bills: RecurringBill[];
}

export type OwnAccount = "checking" | "savings";

export interface AccountBalance {
  id: string;
  type: AccountType;
  /** Checking/savings: money in the account. Credit card: what was charged on it this month. */
  cents: Cents;
}

const DEBITS = new Set<LedgerTxn["kind"]>(["purchase", "withdrawal", "transfer_out", "bill_payment"]);

/**
 * Checking and savings replayed from their opening balances (Nessie never updates balances). A
 * card's balance can't be replayed (its payments land on checking), so a card shows this month's
 * charges instead.
 */
export function balances(ledger: Pick<Ledger, "accounts" | "txns">, asOf: string): AccountBalance[] {
  const month = asOf.slice(0, 7);
  return ledger.accounts.map((a) => {
    let cents = a.type === "Credit Card" ? 0 : a.openingBalanceCents;
    for (const t of ledger.txns) {
      if (t.accountId !== a.id || t.date > asOf) continue;
      const amount = Math.abs(t.amountCents);
      if (a.type === "Credit Card") {
        if (t.kind === "purchase" && t.date.slice(0, 7) === month) cents += amount;
      } else cents += DEBITS.has(t.kind) ? -amount : amount;
    }
    return { id: a.id, type: a.type, cents };
  });
}

export interface SpendingSummary {
  from: string;
  to: string;
  totalCents: Cents;
  count: number;
  /** Biggest first. */
  byMerchant: { name: string; cents: Cents; count: number }[];
  /** The same-length window right before, for "up/down vs before". */
  previousCents: Cents;
}

/** "Card purchase at Trader Joe's" → "Trader Joe's"; Atlas's own trip purchases read as the trip. */
export function merchantOf(description: string): string {
  const d = description.trim();
  if (isAtlasObject(d)) return d.replace(/^\s*\[atlas\]\s*/i, "").trim() || "trip expenses";
  const m = /\bpurchase at\s+(.+)$/i.exec(d);
  return (m ? m[1]! : d).trim() || "other";
}

/** Purchases (debit and card) in the `days` up to and including asOf. */
export function spending(ledger: Pick<Ledger, "txns">, asOf: string, days: number): SpendingSummary {
  const from = addDays(asOf, -(days - 1));
  const prevFrom = addDays(from, -days);
  const byMerchant = new Map<string, { name: string; cents: Cents; count: number }>();
  let totalCents = 0;
  let count = 0;
  let previousCents = 0;
  for (const t of ledger.txns) {
    if (t.kind !== "purchase" || t.date > asOf) continue;
    const amount = Math.abs(t.amountCents);
    if (t.date >= from) {
      totalCents += amount;
      count += 1;
      const name = merchantOf(t.description);
      const key = name.toLowerCase();
      const entry = byMerchant.get(key) ?? { name, cents: 0, count: 0 };
      entry.cents += amount;
      entry.count += 1;
      byMerchant.set(key, entry);
    } else if (t.date >= prevFrom) previousCents += amount;
  }
  return {
    from,
    to: asOf,
    totalCents,
    count,
    byMerchant: [...byMerchant.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name)),
    previousCents,
  };
}

export interface UpcomingBill {
  payee: string;
  cents: Cents;
  due: string;
}

/** Recurring bills due in the next `days` (today included), soonest first. */
export function upcomingBills(bills: RecurringBill[], asOf: string, days = 30): UpcomingBill[] {
  const out: UpcomingBill[] = [];
  for (const b of bills) {
    if (b.status !== "recurring" || b.recurringDay === null || isAtlasObject(b.payee) || isAtlasObject(b.description)) continue;
    const due = nextDue(asOf, b.recurringDay);
    if (daysBetween(asOf, due) < days) out.push({ payee: b.payee, cents: Math.abs(b.amountCents), due });
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.payee.localeCompare(b.payee)));
}

/** The next date on or after asOf that falls on day `dom` (clamped to the month's last day). */
export function nextDue(asOf: string, dom: number): string {
  const [y, m, d] = asOf.split("-").map(Number) as [number, number, number];
  const onMonth = (year: number, month: number) => {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(dom, last)).padStart(2, "0")}`;
  };
  const thisMonth = onMonth(y, m);
  if (Number(thisMonth.slice(8)) >= d) return thisMonth;
  return m === 12 ? onMonth(y + 1, 1) : onMonth(y, m + 1);
}

/** The latest transactions, newest first. Atlas's own bookkeeping included: it really moved money. */
export function recentTransactions(ledger: Pick<Ledger, "txns" | "accounts">, asOf: string, count = 8): (LedgerTxn & { accountType: AccountType })[] {
  const types = new Map(ledger.accounts.map((a) => [a.id, a.type]));
  return ledger.txns
    .filter((t) => t.date <= asOf)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.date < b.t.date ? 1 : a.t.date > b.t.date ? -1 : b.i - a.i))
    .slice(0, count)
    .map(({ t }) => ({ ...t, accountType: types.get(t.accountId) ?? "Checking" }));
}

// ---------- reading a message ----------

export type BankQuery = "balance" | "spending" | "bills" | "transactions";

const BALANCE = /\b(?:(?:my|account|bank|checking|savings)\s+balances?|balances?|how much (?:money )?(?:do i have|is in my|have i got|i got)|what(?:'s| is) in my (?:account|checking|savings|bank)|my accounts?)\b/i;
const SPENDING = /\b(?:(?:my|recent|monthly) spending|how much (?:did|have) i (?:spend|spent)|what (?:did|have) i (?:spend|spent)|where(?:'s| is| does| did)? my money (?:go|going|went)|spending (?:breakdown|summary|this month))\b/i;
const BILLS = /\b(?:(?:my|upcoming|next|what|which) bills?|bills? (?:(?:are|is) )?(?:due|coming up)|what(?:'s| is) due|when(?:'s| is) my (?:\w+ )?bill)\b/i;
const TRANSACTIONS = /\b(?:(?:recent|latest|last few|my) (?:transactions|purchases|charges)|transaction history|what did i buy)\b/i;

/** A plain banking question that code can answer without a model; null for anything else. */
export function parseBankQuery(text: string): BankQuery | null {
  const t = text.trim();
  if (t.length > 120) return null;
  if (TRANSACTIONS.test(t)) return "transactions";
  if (BILLS.test(t)) return "bills";
  if (SPENDING.test(t)) return "spending";
  if (BALANCE.test(t)) return "balance";
  return null;
}

export interface TransferRequest {
  cents: Cents;
  from: OwnAccount;
  to: OwnAccount;
}

const ACCOUNT = "(checking|savings)";
const AMOUNT = "\\$?\\s*(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d{1,2})?)\\s*(k)?(?:\\s*(?:dollars|bucks|usd))?";

/**
 * "move 200 to savings", "transfer $50 from savings to checking", "put 1k in savings",
 * "pull 100 out of savings". Only between the person's own checking and savings.
 */
export function parseTransfer(text: string): TransferRequest | null {
  const t = text.trim().replace(/^\W*(?:atlas[,:]?\s+)?(?:(?:can you|could you|please|pls|plz)\s+)*/i, "");
  const verb = "(?:move|transfer|send|put|shift|stash)";
  const fromTo = new RegExp(`^${verb}\\s+${AMOUNT}\\s+(?:from|out of)\\s+(?:my\\s+)?${ACCOUNT}\\s+(?:to|into|in)\\s+(?:my\\s+)?${ACCOUNT}\\b`, "i").exec(t);
  const toOnly = new RegExp(`^${verb}\\s+${AMOUNT}\\s+(?:to|into|in)\\s+(?:my\\s+)?${ACCOUNT}\\b(?:\\s+(?:from|out of)\\s+(?:my\\s+)?${ACCOUNT}\\b)?`, "i").exec(t);
  const pull = new RegExp(`^(?:pull|take|withdraw|grab)\\s+${AMOUNT}\\s+(?:out of|from)\\s+(?:my\\s+)?${ACCOUNT}\\b`, "i").exec(t);
  const acct = (s: string | undefined) => s?.toLowerCase() as OwnAccount | undefined;
  let m: RegExpExecArray, from: OwnAccount, to: OwnAccount;
  if (fromTo) [m, from, to] = [fromTo, acct(fromTo[3])!, acct(fromTo[4])!];
  else if (toOnly) [m, to, from] = [toOnly, acct(toOnly[3])!, acct(toOnly[4]) ?? other(acct(toOnly[3])!)];
  else if (pull) [m, from, to] = [pull, acct(pull[3])!, other(acct(pull[3])!)];
  else return null;
  if (from === to) return null;
  const cents = Math.round(Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1) * 100);
  return Number.isFinite(cents) && cents > 0 ? { cents, from, to } : null;
}

const other = (a: OwnAccount): OwnAccount => (a === "checking" ? "savings" : "checking");
