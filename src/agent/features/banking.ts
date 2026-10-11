// Personal banking in a private 1:1 chat: "what's my balance", "how much did i spend this
// month", "what bills are coming up", "recent transactions", and "move 200 to savings". Everything
// reads the person's connected account (their Nessie customer, shown as their capital one) through
// the same ledger replay as budgets; nothing here runs in a group chat, where money stays pooled.
// Plain questions are answered by code; the agent gets the same answers through tools for fuzzier
// asks. Every figure shown is registered as private to that person for the money guard.
import { isoDate } from "../../clock.ts";
import { one, q } from "../../db/pool.ts";
import type { MessageRow } from "../../db/repos/core.ts";
import { childLog } from "../../log.ts";
import { balances, parseBankQuery, parseTransfer, recentTransactions, spending, upcomingBills, type BankQuery, type Ledger, type OwnAccount, type TransferRequest } from "../../money/bank.ts";
import { ATLAS_PREFIX, type LedgerTxn } from "../../money/budget.ts";
import { formatUsd } from "../../money/cents.ts";
import { readLedger } from "../../nessie/ledger.ts";
import { linkFor, sharedNessie, type LinkRow } from "../../nessie/seed.ts";
import { bankTransfer } from "../../trips/fund.ts";
import type { Feature, TurnCtx } from "../feature.ts";
import { ToolError, num, say, str, type Tool, type ToolCtx } from "../tools.ts";
import { isConnected, sendConnectLink } from "./connect.ts";

const SPENDING_DAYS = 30;
const BILL_DAYS = 30;

interface TransferRow {
  id: number;
  from_account: OwnAccount;
  to_account: OwnAccount;
  amount_cents: number;
  transfer_date: string;
  nessie_transfer_id: string | null;
}

type Bank = { ok: true; link: LinkRow; ledger: Ledger; ids: Partial<Record<OwnAccount, string>> } | { ok: false; why: "not_connected" | "loading" };

/** The person's accounts as of today, with the transfers they made through Atlas replayed in when Nessie doesn't hold them. */
async function readBank(personId: number): Promise<Bank> {
  const link = await linkFor(personId);
  if (!link || !(await isConnected(personId))) return { ok: false, why: "not_connected" };
  if (link.seed_status !== "ready") return { ok: false, why: "loading" };
  const read = await readLedger(link, sharedNessie());
  const ids: Partial<Record<OwnAccount, string>> = {};
  for (const a of read.accounts) {
    if (a.type === "Checking") ids.checking ??= a.id;
    if (a.type === "Savings") ids.savings ??= a.id;
  }
  const txns = [...read.txns];
  // Generated (offline) histories don't hold Atlas's transfers; Nessie does once they're made there.
  if (read.source === "offline-profile") {
    const rows = await q<TransferRow>(`SELECT id, from_account, to_account, amount_cents::int AS amount_cents, transfer_date::text AS transfer_date, nessie_transfer_id FROM bank_transfers WHERE person_id = $1 ORDER BY id`, [personId]);
    for (const r of rows) {
      const description = `${ATLAS_PREFIX} move to ${r.to_account}`;
      if (ids[r.from_account]) txns.push({ accountId: ids[r.from_account]!, kind: "transfer_out", date: r.transfer_date, amountCents: r.amount_cents, description });
      if (ids[r.to_account]) txns.push({ accountId: ids[r.to_account]!, kind: "transfer_in", date: r.transfer_date, amountCents: r.amount_cents, description });
    }
    txns.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  return { ok: true, link, ledger: { accounts: read.accounts, txns, bills: read.bills }, ids };
}

/** Not connected yet (send the link), or still loading their history. */
async function notReady(tc: ToolCtx, personId: number, why: "not_connected" | "loading"): Promise<void> {
  if (why === "loading") {
    say(tc, "still pulling your accounts, give me a sec and ask again");
    return;
  }
  say(tc, "i need your capital one connected first, then i can pull balances, spending and bills");
  await sendConnectLink(tc, personId);
}

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
const ACCOUNT_NAMES: Record<string, string> = { Checking: "checking", Savings: "savings", "Credit Card": "card" };

function register(tc: ToolCtx, personId: number, cents: number, label: string): string {
  tc.figures.add({ cents, label, source: "nessie:bank", visibility: "private", ownerId: personId });
  return formatUsd(cents, { cents: "always" });
}

/** The deterministic answer to one banking question. Returns the lines it posted. */
export function bankAnswer(kind: BankQuery, ledger: Ledger, today: string, opts: { days?: number; figure: (cents: number, label: string) => string }): string[] {
  const { figure } = opts;
  switch (kind) {
    case "balance": {
      const rows = balances(ledger, today).map((b) =>
        b.type === "Credit Card" ? `- card: ${figure(b.cents, "card charges this month")} charged this month` : `- ${ACCOUNT_NAMES[b.type]}: ${figure(b.cents, `${ACCOUNT_NAMES[b.type]} balance`)}`,
      );
      return [`your accounts right now:\n${rows.join("\n")}`];
    }
    case "spending": {
      const days = Math.min(Math.max(Math.round(opts.days ?? SPENDING_DAYS), 1), 180);
      const s = spending(ledger, today, days);
      if (s.count === 0) return [`no purchases in the last ${days} days`];
      const diff = s.totalCents - s.previousCents;
      const versus =
        s.previousCents > 0 && Math.abs(diff) >= 100 ? ` (${diff > 0 ? "up" : "down"} ${figure(Math.abs(diff), "change in spending vs the period before")} from the ${days} days before)` : "";
      const top = s.byMerchant.slice(0, 5).map((m) => `- ${m.name.toLowerCase()}: ${figure(m.cents, `spent at ${m.name}`)}${m.count > 1 ? ` (${m.count}x)` : ""}`);
      return [`last ${days} days you spent ${figure(s.totalCents, `spending, last ${days} days`)} across ${s.count} purchases${versus}`, `where it went:\n${top.join("\n")}`];
    }
    case "bills": {
      const bills = upcomingBills(ledger.bills, today, BILL_DAYS);
      if (bills.length === 0) return ["no bills coming up in the next month"];
      const total = bills.reduce((sum, b) => sum + b.cents, 0);
      const rows = bills.map((b) => `- ${b.payee.toLowerCase()}: ${figure(b.cents, `${b.payee} bill`)} on ${shortDate(b.due)}`);
      return [`bills in the next ${BILL_DAYS} days:\n${rows.join("\n")}\ntotal: ${figure(total, "bills due in the next month")}`];
    }
    case "transactions": {
      const rows = recentTransactions(ledger, today, 8).map((t) => `- ${shortDate(t.date)} · ${describe(t)}: ${sign(t)}${figure(Math.abs(t.amountCents), `${describe(t)} on ${t.date}`)}`);
      return rows.length ? [`latest activity:\n${rows.join("\n")}`] : ["no activity on your accounts yet"];
    }
  }
}

function describe(t: LedgerTxn & { accountType: string }): string {
  const d = t.description.replace(/^\s*\[atlas\]\s*/i, "").trim();
  if (t.kind === "transfer_in" || t.kind === "transfer_out") return d || `transfer ${t.kind === "transfer_in" ? "into" : "out of"} ${ACCOUNT_NAMES[t.accountType] ?? "account"}`;
  return (d || t.kind).toLowerCase();
}

const sign = (t: LedgerTxn) => (t.kind === "deposit" || t.kind === "transfer_in" ? "+" : "-");

async function answer(tc: ToolCtx, personId: number, kind: BankQuery, days?: number): Promise<string[] | null> {
  const bank = await readBank(personId);
  if (!bank.ok) {
    await notReady(tc, personId, bank.why);
    return null;
  }
  const lines = bankAnswer(kind, bank.ledger, isoDate(tc.now, tc.chat.timezone), { days, figure: (cents, label) => register(tc, personId, cents, label) });
  say(tc, ...lines);
  return lines;
}

/**
 * Move money between the person's own checking and savings. Idempotent per message: a
 * redelivered "move 200 to savings" never moves it twice. Returns what it posted.
 */
async function moveMoney(tc: ToolCtx, personId: number, req: TransferRequest): Promise<string[]> {
  const bank = await readBank(personId);
  if (!bank.ok) {
    await notReady(tc, personId, bank.why);
    return [];
  }
  const fromId = bank.ids[req.from];
  const toId = bank.ids[req.to];
  if (!fromId || !toId) return say(tc, `you don't have a ${!fromId ? req.from : req.to} account connected`);
  const today = isoDate(tc.now, tc.chat.timezone);
  const before = new Map(balances(bank.ledger, today).map((b) => [b.id, b.cents]));
  const available = before.get(fromId) ?? 0;
  if (req.cents > available) {
    return say(tc, `you've only got ${register(tc, personId, available, `${req.from} balance`)} in ${req.from}, so i can't move ${register(tc, personId, req.cents, "requested transfer")}`);
  }
  await tc.nonCancellable();
  const row = await one<{ id: number }>(
    `INSERT INTO bank_transfers (person_id, source_message_id, from_account, to_account, amount_cents, transfer_date, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (source_message_id) DO NOTHING RETURNING id`,
    [personId, tc.sourceMessageId, req.from, req.to, req.cents, today, tc.now],
  );
  if (!row) return []; // already done for this message
  const client = sharedNessie();
  if (client && !bank.link.seed_progress.offline) {
    try {
      const done = await bankTransfer(client, { accountId: fromId, personId }, { accountId: toId, personId }, req.cents, `${ATLAS_PREFIX} move to ${req.to}`);
      await q(`UPDATE bank_transfers SET nessie_transfer_id = $2, nessie_deposit_id = $3 WHERE id = $1`, [row.id, done.transferId, done.depositId]);
    } catch (err) {
      childLog({ component: "banking" }).warn({ err: (err as Error).message, personId }, "transfer failed");
      await q(`DELETE FROM bank_transfers WHERE id = $1`, [row.id]);
      return say(tc, "the bank didn't go through on that one, nothing moved. try again in a minute");
    }
  }
  const fromAfter = available - req.cents;
  const toAfter = (before.get(toId) ?? 0) + req.cents;
  return say(
    tc,
    `done ✓ moved ${register(tc, personId, req.cents, "amount moved")} from ${req.from} to ${req.to}\n${req.from}: ${register(tc, personId, fromAfter, `${req.from} balance`)} · ${req.to}: ${register(tc, personId, toAfter, `${req.to} balance`)}`,
  );
}

const checkMyBank: Tool = {
  scope: "dm",
  soloPost: true,
  decl: {
    name: "check_my_bank",
    description:
      "Private chat only. Look at the person's own connected capital one: balances, spending (where their money went over the last N days, top places), upcoming bills, or their latest transactions. Posts the answer itself. If they aren't connected it sends their connect link instead.",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", enum: ["balance", "spending", "bills", "transactions"] },
        days: { type: "number", description: "for spending: how many days back (default 30)" },
      },
      required: ["what"],
    },
  },
  async run(args, ctx) {
    const what = str(args.what) as BankQuery | undefined;
    if (!what || !["balance", "spending", "bills", "transactions"].includes(what)) throw new ToolError("what must be balance, spending, bills or transactions");
    if (ctx.senderId === null) throw new ToolError("no sender");
    const posted = await answer(ctx, ctx.senderId, what, num(args.days));
    return { ok: true, posted: posted ?? undefined, next: posted ? "the numbers were posted; don't repeat them. add one short line only if it helps (a pattern, a tip)" : "they need to connect first; the link was posted" };
  },
};

const moveMyMoney: Tool = {
  scope: "dm",
  soloPost: true,
  sideEffects: true,
  decl: {
    name: "move_my_money",
    description:
      "Private chat only. Move money between the person's OWN checking and savings, only when they clearly asked to with an amount (\"move 200 to savings\"). Never between people; trip money goes through the trip fund and settle-up instead.",
    parameters: {
      type: "object",
      properties: {
        amount_usd: { type: "number" },
        from: { type: "string", enum: ["checking", "savings"] },
        to: { type: "string", enum: ["checking", "savings"] },
      },
      required: ["amount_usd", "from", "to"],
    },
  },
  async run(args, ctx) {
    const amount = num(args.amount_usd);
    const from = str(args.from) as OwnAccount | undefined;
    const to = str(args.to) as OwnAccount | undefined;
    if (!amount || amount <= 0) throw new ToolError("amount_usd must be a positive dollar amount");
    if (!from || !to || from === to || ![from, to].every((a) => a === "checking" || a === "savings")) throw new ToolError("from and to must be checking and savings (different)");
    if (ctx.senderId === null) throw new ToolError("no sender");
    const posted = await moveMoney(ctx, ctx.senderId, { cents: Math.round(amount * 100), from, to });
    return { ok: true, posted, next: "the result was posted; don't repeat it" };
  },
};

export const bankingFeature: Feature = {
  name: "banking",
  tools: [checkMyBank, moveMyMoney],

  async directMessage(msg: MessageRow, tc: TurnCtx) {
    if (msg.person_id === null || msg.kind !== "text") return false;
    const transfer = parseTransfer(msg.text);
    if (transfer) {
      await moveMoney(tc, msg.person_id, transfer);
      return true;
    }
    const query = parseBankQuery(msg.text);
    if (!query) return false;
    await answer(tc, msg.person_id, query);
    return true;
  },

  async situation(tc) {
    if (tc.chat.is_group || tc.senderId === null) return null;
    const link = await linkFor(tc.senderId);
    const connected = await isConnected(tc.senderId);
    const state = connected ? (link?.seed_status === "ready" ? "connected ✓" : "connected, still loading their history") : "not connected (send_connect_link sends their link)";
    return {
      title: "their banking (private chat: their own money only)",
      lines: [
        `capital one: ${state}`,
        "check_my_bank answers balances, spending, upcoming bills and recent transactions; move_my_money moves money between their own checking and savings when they ask with an amount",
        "never quote a balance or a purchase you didn't get from a tool this turn",
      ],
    };
  },
};
