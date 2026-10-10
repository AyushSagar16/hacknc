// Reads a person's Nessie accounts back into the budget engine's ledger. Nessie never updates
// account balances, so the opening balance plus every transaction is replayed. When Nessie is
// unreachable, cached reads are used; with no cache either, the same deterministic demo profile
// is computed locally — and every result says which of these it was.
import { childLog } from "../log.ts";
import type { LedgerAccount, LedgerTxn, RecurringBill } from "../money/budget.ts";
import { profileToLedger } from "./personas.ts";
import { NessieError, NessieUnavailable, type NessieClient } from "./client.ts";
import { profileFor, type LinkRow } from "./seed.ts";

export interface LedgerRead {
  accounts: LedgerAccount[];
  txns: LedgerTxn[];
  bills: RecurringBill[];
  source: "nessie" | "nessie-cache" | "offline-profile";
  fetchedAt: Date | null;
  accountIds: string[];
}

type Obj = Record<string, unknown>;
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function readLedger(link: LinkRow, client: NessieClient | null): Promise<LedgerRead> {
  if (!client || link.seed_progress.offline || !link.checking_id) return offline(link);
  const ids = [link.checking_id, link.savings_id, link.credit_id].filter((x): x is string => Boolean(x));
  try {
    let fromCache = false;
    let oldest: Date | null = null;
    const note = (r: { fromCache: boolean; fetchedAt: Date }) => {
      fromCache ||= r.fromCache;
      if (!oldest || r.fetchedAt < oldest) oldest = r.fetchedAt;
    };
    const accounts: LedgerAccount[] = [];
    const txns: LedgerTxn[] = [];
    const bills: RecurringBill[] = [];
    const seenTransfers = new Set<string>();
    for (const id of ids) {
      const acct = await client.account(id, link.person_id);
      note(acct);
      const type = str(acct.value.type) as LedgerAccount["type"];
      accounts.push({ id, type: type || "Checking", openingBalanceCents: cents(acct.value.balance) });
      for (const kind of ["deposits", "withdrawals", "purchases"] as const) {
        const list = await client.listOn<Obj[]>(id, kind, link.person_id);
        note(list);
        for (const t of list.value) {
          txns.push({
            accountId: id,
            kind: kind === "deposits" ? "deposit" : kind === "withdrawals" ? "withdrawal" : "purchase",
            date: str(t.transaction_date ?? t.purchase_date).slice(0, 10),
            amountCents: cents(t.amount),
            description: str(t.description),
          });
        }
      }
      const transfers = await client.listOn<Obj[]>(id, "transfers", link.person_id);
      note(transfers);
      for (const t of transfers.value) {
        const key = str(t._id);
        if (key && seenTransfers.has(`${key}:${id}`)) continue;
        seenTransfers.add(`${key}:${id}`);
        const outgoing = !t.payer_id || t.payer_id === id;
        txns.push({ accountId: id, kind: outgoing ? "transfer_out" : "transfer_in", date: str(t.transaction_date).slice(0, 10), amountCents: cents(t.amount), description: str(t.description) });
      }
      if (type === "Checking") {
        const list = await client.listOn<Obj[]>(id, "bills", link.person_id);
        note(list);
        for (const b of list.value) {
          bills.push({
            accountId: id,
            payee: str(b.payee),
            amountCents: cents(b.payment_amount),
            recurringDay: typeof b.recurring_date === "number" ? b.recurring_date : null,
            status: (str(b.status) || "pending") as RecurringBill["status"],
            description: str(b.nickname),
          });
        }
      }
    }
    txns.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { accounts, txns, bills, source: fromCache ? "nessie-cache" : "nessie", fetchedAt: oldest, accountIds: ids };
  } catch (err) {
    if (err instanceof NessieUnavailable || (err instanceof NessieError && err.status >= 500)) {
      childLog({ component: "nessie.ledger" }).warn({ err: (err as Error).message }, "nessie unavailable with no cache; using the local demo profile");
      return offline(link);
    }
    throw err;
  }
}

function offline(link: LinkRow): LedgerRead {
  const ledger = profileToLedger(profileFor(link));
  return { ...ledger, source: "offline-profile", fetchedAt: null, accountIds: [] };
}
