// Trip money through Nessie, end to end:
//   (a)+(b) shares and the payment plan are the trip fund now (features/fund.ts): contributions
//       on each person's paydays into a shared fund account; this file keeps the split mode;
//   (c) "i paid 64 for dinner" → a Nessie purchase on the payer's account + an exact-cents ledger
//       row (idempotent by source message), disputes fixed only with the payer's confirmation;
//   (d) the combined settle-up (tab + trip fund, src/money/fund.ts) with the fewest transfers,
//       each executed as a Nessie transfer only after the person paying confirms in the chat;
//       fund leftovers are refunded pro-rata, a shortfall is paid into the fund.
// All arithmetic is deterministic code; every figure posted is registered for the money guard.
import { addDays, now } from "../../clock.ts";
import { childLog } from "../../log.ts";
import { formatUsd } from "../../money/cents.ts";
import { combinedSettle, FUND, fundShares } from "../../money/fund.ts";
import { splitByItems, splitEvenly } from "../../money/split.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, labelOf, type MessageRow } from "../../db/repos/core.ts";
import { enqueueJob } from "../../pipeline/jobs.ts";
import { capabilities, nessieAmount } from "../../nessie/capabilities.ts";
import { linkFor, sharedNessie, tripMerchant } from "../../nessie/seed.ts";
import { parseExpense } from "../../trips/expenseParse.ts";
import { doneBy, fundItems, payDueItems, recordContribution, refundFromFund } from "../../trips/fund.ts";
import { activeExpenses, categorize, expenseByKey, expenseNumber, insertExpense, numberOf, openSettlements, proposeSettlements, setExpenseNessie, spentSoFar, tripBalances, voidExpense, type ExpenseRow, type SettlementRow } from "../../trips/ledger.ts";
import { tripById, updateTrip } from "../../trips/state.ts";
import type { AppServices, Feature, TurnCtx } from "../feature.ts";
import { looksLikeStay, postFundPlan, recordOwnStay, stayName } from "./fund.ts";
import { nameList } from "./planning.ts";
import type { Figure } from "../figures.ts";
import { ToolError, num, say, str, strList, type Tool } from "../tools.ts";

const log = () => childLog({ component: "money" });
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();

// ---------- (a)+(b) cost split ----------
// The payment plan is the trip fund's contribution schedule now (features/fund.ts): shares of
// the stay and shared items, paid in on paydays. Travel is each person's own cost.

/** Change how the trip fund is shared and re-post the plan when there is one. */
export async function setSplitMode(tc: TurnCtx, mode: "by_cost" | "even"): Promise<void> {
  const changed = tc.trip.split_mode !== mode;
  if (changed) {
    await tc.nonCancellable();
    tc.trip = await updateTrip(tc.trip.id, { split_mode: mode });
  }
  if (await postFundPlan(tc, { compact: true })) {
    say(tc, mode === "even" ? `everyone pays the same now. "split by cost" switches back` : "each shared cost is split among the people it's for now");
    return;
  }
  say(tc, mode === "even" ? "got it, everyone pays the same. the trip fund will be split evenly once the stay's booked" : "got it, each shared cost gets split among the people it's for");
}

// ---------- (c) expenses ----------

interface LogInput {
  payerId: number;
  amountCents: number;
  description: string;
  splitIds: number[] | null;
  items?: { name: string; amountCents: number; sharedBy: number[] }[];
  key: string;
  replacesId?: number | null;
  sourceMessageId: number | null;
}

async function pushNessiePurchase(expense: ExpenseRow, n: number): Promise<boolean> {
  const client = sharedNessie();
  const link = await linkFor(expense.payer_id);
  if (!client || !link?.checking_id || link.seed_progress.offline) return false;
  const merchant = await tripMerchant(client, expense.category);
  const made = await client.createOn(
    link.checking_id,
    "purchases",
    {
      merchant_id: merchant,
      medium: "balance",
      purchase_date: expense.spent_on,
      amount: nessieAmount(expense.amount_cents),
      status: "completed",
      description: `[atlas] ${expense.description} ${formatUsd(expense.amount_cents, { cents: "always" })} split ${n} ways`,
    },
    expense.payer_id,
  );
  await setExpenseNessie(expense.id, made.id);
  return true;
}

function describeSplit(expense: ExpenseRow, tc: TurnCtx): string {
  const entries = Object.entries(expense.shares).map(([id, c]) => [Number(id), c] as const);
  const others = entries.filter(([id]) => id !== expense.payer_id && expenseShare(expense, id) > 0);
  const amounts = new Set(entries.map(([, c]) => c));
  if (amounts.size <= 2 && Math.max(...amounts) - Math.min(...amounts) <= 1 && entries.length === tc.members.length) {
    // An uneven cent goes to the payer; say so, or "$21.33 each" × 3 looks a penny short.
    const payerShare = expenseShare(expense, expense.payer_id);
    const penny = others.length && payerShare > 0 && payerShare !== others[0]![1] ? ` (${tc.label(expense.payer_id).toLowerCase()}'s share is ${formatUsd(payerShare, { cents: "always" })})` : "";
    return `split ${entries.length} ways${others.length ? `: ${nameList(others.map(([id]) => tc.label(id).toLowerCase()))} owe ${tc.label(expense.payer_id).toLowerCase()} ${formatUsd(others[0]![1], { cents: "always" })} each${penny}` : ""}`;
  }
  return others.map(([id, c]) => `${tc.label(id).toLowerCase()} owes ${formatUsd(c, { cents: "always" })}`).join(", ");
}

const expenseShare = (e: ExpenseRow, id: number) => e.shares[String(id)] ?? 0;

function expenseFigures(e: ExpenseRow): Figure[] {
  const out: Figure[] = [{ cents: e.amount_cents, label: `expense: ${e.description}`, source: e.nessie_purchase_id ? `nessie:${e.nessie_purchase_id}` : `ledger:${e.id}`, visibility: "public" }];
  for (const c of new Set(Object.values(e.shares))) out.push({ cents: c, label: `share of ${e.description}`, source: `ledger:${e.id}`, visibility: "public" });
  return out;
}

export async function logExpense(tc: TurnCtx, input: LogInput): Promise<{ expense: ExpenseRow; text: string; duplicate: boolean }> {
  if (tc.trip.status === "done") throw new ToolError("this trip is settled and closed");
  const existing = await expenseByKey(input.key);
  if (existing) return { expense: existing, text: "", duplicate: true };
  const members = input.splitIds ?? tc.members.map((m) => m.id);
  if (members.length === 0) throw new ToolError("nobody to split with");
  if (members.length === 1 && members[0] === input.payerId && !input.items?.length) throw new ToolError("that's only the payer — nothing to split");
  const shares = input.items?.length
    ? splitByItems(input.items.map((i) => ({ name: i.name, amountCents: i.amountCents, sharedBy: i.sharedBy })), input.amountCents, { remainderTo: input.payerId })
    : splitEvenly(input.amountCents, members, { remainderTo: input.payerId });
  await tc.nonCancellable();
  const expense = await insertExpense({
    trip_id: tc.trip.id,
    payer_id: input.payerId,
    amount_cents: input.amountCents,
    description: input.description.slice(0, 80),
    category: categorize(input.description),
    shares: Object.fromEntries([...shares].map(([k, v]) => [String(k), v])),
    items: input.items ?? [],
    source_message_id: input.sourceMessageId,
    idempotency_key: input.key,
    replaces_id: input.replacesId ?? null,
    spent_on: tc.today,
  });
  let inNessie = false;
  try {
    inNessie = await pushNessiePurchase(expense, shares.size);
  } catch (err) {
    log().warn({ err: (err as Error).message, expenseId: expense.id }, "nessie purchase failed; will retry");
    await enqueueJob("nessie.sync_expense", { expenseId: expense.id }, { singletonKey: `expense:${expense.id}`, dueAt: new Date(now().getTime() + 30_000) });
  }
  const fresh = (await expenseByKey(input.key))!;
  tc.figures.addAll(expenseFigures(fresh));
  const n = await numberOf(fresh);
  const text = `logged #${n}: ${fresh.description} ${formatUsd(fresh.amount_cents, { cents: "always" })}, paid by ${tc.label(fresh.payer_id).toLowerCase()}${inNessie ? " (on their account ✓)" : sharedNessie() ? " (syncing to their account)" : ""}. ${describeSplit(fresh, tc)}`;
  return { expense: fresh, text, duplicate: false };
}

async function undoInNessie(expense: ExpenseRow): Promise<void> {
  const client = sharedNessie();
  const link = await linkFor(expense.payer_id);
  if (!client || !expense.nessie_purchase_id || !link?.checking_id) return;
  try {
    if (capabilities().purchaseDelete && (await client.remove(`/purchases/${expense.nessie_purchase_id}`, expense.payer_id))) return;
    // No deletes on this Nessie: offset the purchase with a correcting deposit.
    await client.createOn(
      link.checking_id,
      "deposits",
      { medium: "balance", transaction_date: expense.spent_on, status: "completed", amount: nessieAmount(expense.amount_cents), description: `[atlas] correction: void ${expense.description}` },
      expense.payer_id,
    );
  } catch (err) {
    log().warn({ err: (err as Error).message }, "could not offset voided purchase in nessie");
  }
}

async function fixExpense(tc: TurnCtx, old: ExpenseRow, change: { amountCents?: number; splitIds?: number[] }, key: string): Promise<string> {
  await tc.nonCancellable();
  await voidExpense(old.id);
  await undoInNessie(old);
  const splitIds = change.splitIds ?? Object.keys(old.shares).map(Number);
  const { text, expense } = await logExpense(tc, {
    payerId: old.payer_id,
    amountCents: change.amountCents ?? old.amount_cents,
    description: old.description,
    splitIds,
    key,
    replacesId: old.id,
    sourceMessageId: tc.sourceMessageId,
  });
  return text.replace(/^logged #\d+/, `fixed (was #${await numberOf(old)}, now #${await numberOf(expense)})`);
}

// ---------- (d) balances and settle-up ----------

async function balanceLines(tc: TurnCtx): Promise<string[]> {
  const b = await tripBalances(tc.trip.id, tc.members.map((m) => m.id));
  if (b.count === 0) return ["no shared expenses yet"];
  tc.figures.add({ cents: b.totalCents, label: "total shared spending", source: "ledger:expenses", visibility: "public" });
  for (const p of b.plan) tc.figures.add({ cents: p.amountCents, label: `${tc.label(p.from)} owes ${tc.label(p.to)}`, source: "ledger:balances", visibility: "public" });
  if (b.plan.length === 0) return [`${formatUsd(b.totalCents, { cents: "always" })} across ${b.count} expenses, and everyone's even`];
  return [`who owes who (${b.count} expenses, ${formatUsd(b.totalCents, { cents: "always" })} total):`, ...b.plan.map((p) => `${tc.label(p.from).toLowerCase()} → ${tc.label(p.to).toLowerCase()} ${formatUsd(p.amountCents, { cents: "always" })}`)];
}

/** Who a settle-up line names: a person, or the trip fund (to_id NULL). */
const party = (label: (id: number) => string, id: number | null) => (id === null || id === FUND ? "the trip fund" : label(id).toLowerCase());

/**
 * The combined settle-up: the tab and the trip fund squared in one list (src/money/fund.ts).
 * A fund leftover goes back first, fund → checking, in proportion to what each person put in;
 * a shortfall makes the fund one more party that the people who are behind pay into.
 */
async function proposeSettleUp(tc: TurnCtx): Promise<void> {
  const memberIds = tc.members.map((m) => m.id);
  const tab = await tripBalances(tc.trip.id, memberIds);
  const items = await fundItems(tc.trip.id);
  const contributed = await doneBy(tc.trip.id, "contribution");
  const refunded = await doneBy(tc.trip.id, "refund");
  const hasFund = items.length > 0 || contributed.size > 0;
  if (tab.count === 0 && !hasFund) {
    say(tc, "nothing to settle yet, no shared expenses logged");
    return;
  }
  const spendShares = fundShares(
    items.map((i) => ({ amountCents: i.amount_cents, sharedBy: i.shared_by })),
    memberIds,
    tc.trip.split_mode ?? "by_cost",
  );
  const result = combinedSettle({ members: memberIds, contributed, refunded, spendShares, tab: tab.net });
  await tc.nonCancellable();
  // The settle-up squares the fund from here: no more scheduled contributions.
  await q(`UPDATE fund_txns SET status = 'cancelled' WHERE trip_id = $1 AND kind = 'contribution' AND status IN ('scheduled','failed') AND due_date IS NOT NULL AND idempotency_key LIKE 'fundc:%'`, [tc.trip.id]);
  const bubbles: string[] = [];
  if (result.refunds.size) {
    const sent: string[] = [];
    for (const [id, cents] of result.refunds) {
      await refundFromFund(tc.trip, id, cents, `refund:${tc.trip.id}:${id}:${refunded.get(id) ?? 0}:${cents}`);
      tc.figures.add({ cents, label: `${tc.label(id)}'s fund refund`, source: "ledger:fund", visibility: "public" });
      sent.push(`${tc.label(id).toLowerCase()} ${formatUsd(cents, { cents: "always" })}`);
    }
    tc.figures.add({ cents: result.leftoverCents, label: "fund leftover", source: "ledger:fund", visibility: "public" });
    bubbles.push(`🏦 the trip fund had ${formatUsd(result.leftoverCents, { cents: "always" })} left over, sent back in proportion to what you each put in: ${sent.join(", ")} ✓`);
  }
  if (result.shortfallCents) {
    tc.figures.add({ cents: result.shortfallCents, label: "fund shortfall", source: "ledger:fund", visibility: "public" });
    bubbles.push(`the trip fund is ${formatUsd(result.shortfallCents, { cents: "always" })} short of what it pays for, so that's folded in below`);
  }
  if (result.transfers.length === 0) {
    say(tc, ...bubbles, "everyone's already even 🎉");
    return;
  }
  const rows = await proposeSettlements(
    tc.trip.id,
    result.transfers.map((t) => ({ from: t.from, to: t.to === FUND ? null : t.to, amountCents: t.amountCents })),
  );
  await q(`UPDATE confirmations SET status = 'expired', resolved_at = $2 WHERE chat_id = $1 AND kind = 'settlement' AND status = 'pending'`, [tc.chat.id, tc.now]);
  const payers = [...new Set(rows.map((r) => r.from_id))];
  for (const p of payers) {
    await q(`INSERT INTO confirmations (chat_id, person_id, kind, payload, created_at) VALUES ($1,$2,'settlement',$3,$4)`, [tc.chat.id, p, JSON.stringify({ planId: rows[0]!.plan_id }), tc.now]);
  }
  if (tc.trip.status !== "done") tc.trip = await updateTrip(tc.trip.id, { status: "settling" });
  for (const r of rows) tc.figures.add({ cents: r.amount_cents, label: `${party(tc.label, r.from_id)} pays ${party(tc.label, r.to_id)}`, source: "ledger:settle-up", visibility: "public" });
  const list = rows.map((r) => `${party(tc.label, r.from_id)} → ${party(tc.label, r.to_id)} ${formatUsd(r.amount_cents, { cents: "always" })}`).join("\n");
  say(
    tc,
    ...bubbles,
    `settle-up, the fewest transfers that square ${hasFund ? "the tab and the trip fund" : "everything"} (${rows.length}):\n${list}`,
    `${nameList(payers.map((p) => tc.label(p).toLowerCase()))}, reply "confirm" and i'll send yours straight from your checking`,
  );
}

/** A settle-up payment into the trip fund: a contribution from the payer's checking, then pay what it now covers. */
async function executeIntoFund(s: SettlementRow, label: (id: number) => string): Promise<string> {
  const line = `${party(label, s.from_id)} → the trip fund ${formatUsd(s.amount_cents, { cents: "always" })}`;
  const trip = await tripById(s.trip_id);
  if (!trip) throw new Error(`no trip ${s.trip_id}`);
  await q(`UPDATE settlements SET status = 'executing' WHERE id = $1`, [s.id]);
  try {
    const txn = await recordContribution(trip, s.from_id, s.amount_cents, `settle:${s.idempotency_key}`);
    await q(`UPDATE settlements SET status = 'executed', executed_at = $2, nessie_transfer_id = $3, nessie_deposit_id = $4, last_error = $5 WHERE id = $1`, [
      s.id,
      now(),
      txn.nessie_transfer_id,
      txn.nessie_deposit_id,
      txn.via === "ledger" ? "offline: recorded only" : null,
    ]);
    const paid = await payDueItems(trip);
    return [`✓ ${txn.via === "bank" ? "sent: " : ""}${line}${txn.via === "ledger" ? " recorded" : ""}`, ...paid.map((i) => `${i.description} is paid in full from the fund ✓`)].join("\n");
  } catch (err) {
    await q(`UPDATE settlements SET status = 'failed', last_error = $2 WHERE id = $1`, [s.id, (err as Error).message.slice(0, 300)]);
    throw err;
  }
}

async function executeSettlement(s: SettlementRow, label: (id: number) => string): Promise<string> {
  if (s.to_id === null) return executeIntoFund(s, label);
  const client = sharedNessie();
  const [from, to] = await Promise.all([linkFor(s.from_id), linkFor(s.to_id)]);
  await q(`UPDATE settlements SET status = 'executing' WHERE id = $1`, [s.id]);
  const description = `[atlas] settle-up ${label(s.from_id)} to ${label(s.to_id)} ${formatUsd(s.amount_cents, { cents: "always" })} (${s.idempotency_key})`;
  const at = now().toISOString().slice(0, 10);
  if (!client || !from?.checking_id || !to?.checking_id || from.seed_progress.offline || to.seed_progress.offline) {
    await q(`UPDATE settlements SET status = 'executed', executed_at = $2, last_error = 'offline: recorded only' WHERE id = $1`, [s.id, now()]);
    return `✓ ${label(s.from_id).toLowerCase()} → ${label(s.to_id).toLowerCase()} ${formatUsd(s.amount_cents, { cents: "always" })} recorded`;
  }
  try {
    let transferId = s.nessie_transfer_id;
    let depositId = s.nessie_deposit_id;
    const amount = nessieAmount(s.amount_cents);
    if (!transferId) {
      transferId = capabilities().transferWithPayee
        ? (await client.createOn(from.checking_id, "transfers", { medium: "balance", payee_id: to.checking_id, amount, transaction_date: at, status: "completed", description }, s.from_id)).id
        : (await client.createOn(from.checking_id, "transfers", { transaction_date: at, status: "completed", amount, description }, s.from_id)).id;
      await q(`UPDATE settlements SET nessie_transfer_id = $2 WHERE id = $1`, [s.id, transferId]);
    }
    if (!capabilities().transferWithPayee && !depositId) {
      // This Nessie can't name a payee on a transfer, so the payee's side is a matching deposit.
      depositId = (await client.createOn(to.checking_id, "deposits", { medium: "balance", transaction_date: at, status: "completed", amount, description }, s.to_id)).id;
      await q(`UPDATE settlements SET nessie_deposit_id = $2 WHERE id = $1`, [s.id, depositId]);
    }
    await q(`UPDATE settlements SET status = 'executed', executed_at = $2, last_error = NULL WHERE id = $1`, [s.id, now()]);
    return `✓ sent: ${label(s.from_id).toLowerCase()} → ${label(s.to_id).toLowerCase()} ${formatUsd(s.amount_cents, { cents: "always" })}`;
  } catch (err) {
    await q(`UPDATE settlements SET status = 'failed', last_error = $2 WHERE id = $1`, [s.id, (err as Error).message.slice(0, 300)]);
    throw err;
  }
}

async function confirmSettlement(tc: TurnCtx, personId: number, planId: string): Promise<void> {
  await tc.nonCancellable();
  const mine = (await openSettlements(tc.trip.id)).filter((s) => s.plan_id === planId && s.from_id === personId && s.status !== "executing");
  for (const s of mine) {
    tc.figures.add({ cents: s.amount_cents, label: "settle-up transfer", source: "ledger:settle-up", visibility: "public" });
    try {
      say(tc, await executeSettlement(s, tc.label));
    } catch {
      await enqueueJob("settle.execute", { settlementId: s.id, chatId: tc.chat.id }, { singletonKey: `settle:${s.id}`, dueAt: new Date(now().getTime() + 20_000) });
      say(tc, `the bank isn't answering right now, i'll send ${tc.label(s.from_id).toLowerCase()} → ${tc.label(s.to_id).toLowerCase()} as soon as it's back`);
    }
  }
  await finishIfSettled(tc);
}

async function finishIfSettled(tc: TurnCtx): Promise<void> {
  const open = await openSettlements(tc.trip.id);
  const executed = await one<{ n: number }>(`SELECT count(*)::int AS n FROM settlements WHERE trip_id = $1 AND status = 'executed'`, [tc.trip.id]);
  if (open.length === 0 && (executed?.n ?? 0) > 0) {
    tc.trip = await updateTrip(tc.trip.id, { status: "done" });
    say(tc, "and that's everyone, all settled up 🎉");
  }
}

// ---------- confirmations ----------

const YES = /^\W*(yes|yep|yeah|ya|y|confirm(ed)?|correct|do it|send it|go ahead|ok(ay)?|sure|👍)\b/i;
const NO = /^\W*(no|nope|nah|cancel|don'?t|wait)\b/i;

async function resolveConfirmation(msg: MessageRow, tc: TurnCtx): Promise<boolean> {
  if (msg.person_id === null || msg.kind !== "text") return false;
  const yes = YES.test(msg.text);
  const no = !yes && NO.test(msg.text);
  if (!yes && !no) return false;
  const pending = await one<{ id: number; kind: string; payload: Record<string, unknown> }>(
    `SELECT id, kind, payload FROM confirmations WHERE chat_id = $1 AND person_id = $2 AND status = 'pending' AND created_at > $3 ORDER BY id DESC LIMIT 1`,
    [tc.chat.id, msg.person_id, new Date(tc.now.getTime() - 24 * 3_600_000)],
  );
  if (!pending) return false;
  await q(`UPDATE confirmations SET status = $2, resolved_at = $3 WHERE id = $1`, [pending.id, yes ? "confirmed" : "declined", tc.now]);
  tc.senderId = msg.person_id;
  tc.sourceMessageId = msg.id;
  if (pending.kind === "settlement") {
    if (yes) await confirmSettlement(tc, msg.person_id, String(pending.payload.planId));
    else say(tc, `ok, holding off on ${tc.label(msg.person_id).toLowerCase()}'s transfer`);
    return true;
  }
  if (pending.kind === "expense_fix") {
    const old = await one<ExpenseRow>(`SELECT * FROM expenses WHERE id = $1`, [Number(pending.payload.expenseId)]);
    if (!old || old.status !== "active") return true;
    if (!yes) {
      say(tc, `keeping #${await numberOf(old)} as is`);
      return true;
    }
    if (pending.payload.remove) {
      await tc.nonCancellable();
      await voidExpense(old.id);
      await undoInNessie(old);
      say(tc, `removed #${await numberOf(old)} (${old.description})`);
      return true;
    }
    const text = await fixExpense(
      tc,
      old,
      { amountCents: typeof pending.payload.amountCents === "number" ? pending.payload.amountCents : undefined, splitIds: Array.isArray(pending.payload.splitIds) ? (pending.payload.splitIds as number[]) : undefined },
      `fix:${old.id}:${pending.id}`,
    );
    say(tc, text);
    return true;
  }
  return false;
}

/** An expense that's the place someone booked for the group becomes the trip's stay too, so the plan moves on. */
async function stayFromExpense(tc: TurnCtx, description: string, amountCents: number, explicit?: boolean): Promise<string | null> {
  if (explicit === false || (explicit !== true && !looksLikeStay(description))) return null;
  const name = stayName(description);
  return (await recordOwnStay(tc, name, amountCents)) ? `🏠 ${name} is our stay ✓` : null;
}

// ---------- tools ----------

const logExpenseTool: Tool = {
  decl: {
    name: "log_expense",
    description:
      "Log a trip expense the SENDER paid for others (\"i covered the boat for me, leo and priya\", itemized receipts). Buying for someone else counts: \"i got leo's ticket, $40\" or \"bought dinner for priya 30\" → split_among [\"leo\"] / [\"priya\"] without the payer, so they owe it all. Never log prices people are only discussing, or what someone else paid. Posts its own confirmation.",
    parameters: {
      type: "object",
      properties: {
        amount_usd: { type: "number" },
        description: { type: "string" },
        split_among: { type: "array", items: { type: "string" }, description: "first names of who it was for; include \"me\" when the payer shared it; omit for everyone" },
        items: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, amount_usd: { type: "number" }, shared_by: { type: "array", items: { type: "string" } } }, required: ["name", "amount_usd", "shared_by"] },
          description: "per-item lines; tax/tip/fees left over are shared in proportion",
        },
        is_stay: { type: "boolean", description: "true when this is where the group is staying and the sender booked it (\"i booked mountain inn, 2 nights at 100\"): it also becomes the trip's stay so planning moves on" },
      },
      required: ["amount_usd", "description"],
    },
  },
  sideEffects: true,
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const amount = num(args.amount_usd);
    const description = str(args.description);
    if (!amount || amount <= 0 || !description) throw new ToolError("need a positive amount_usd and a description");
    if (Math.round(amount * 100) !== Math.round(amount * 100 * 1000) / 1000) throw new ToolError("amount must be in whole cents");
    if (tc.senderId === null) throw new ToolError("no sender");
    const resolveAll = (names: string[]) =>
      names.map((n) => {
        const id = tc.resolve(n);
        if (id === undefined) throw new ToolError(`${n} isn't in this chat`);
        return id;
      });
    const split = strList(args.split_among);
    const items = Array.isArray(args.items)
      ? (args.items as { name: string; amount_usd: number; shared_by: string[] }[]).map((i) => ({ name: String(i.name), amountCents: Math.round(Number(i.amount_usd) * 100), sharedBy: resolveAll(strList(i.shared_by)) }))
      : undefined;
    const ordinal = (tc.notes.get("expenseOrdinal") as number | undefined) ?? 0;
    tc.notes.set("expenseOrdinal", ordinal + 1);
    const { text, duplicate } = await logExpense(tc, {
      payerId: tc.senderId,
      amountCents: Math.round(amount * 100),
      description,
      splitIds: split.length ? [...new Set(resolveAll(split))] : null,
      items,
      key: `exp:${tc.sourceMessageId ?? `t${tc.turnId}`}:${ordinal}`,
      sourceMessageId: tc.sourceMessageId,
    });
    if (duplicate) return { ok: true, next: "already logged from this message; say nothing" };
    const stay = await stayFromExpense(tc, description, Math.round(amount * 100), typeof args.is_stay === "boolean" ? args.is_stay : undefined);
    const posted = stay ? `${text}\n${stay}` : text;
    say(tc, posted);
    return stay ? { ok: true, posted: [posted], next: "that's the trip's stay now; the food question goes out on its own. reply NO_REPLY" } : { ok: true, posted: [posted] };
  },
};

const correctExpenseTool: Tool = {
  decl: {
    name: "correct_expense",
    description:
      "Fix or remove a logged expense (\"it was 46 not 64\", \"i didn't have the wine, leave me out of #3\", \"delete #2\"). If the sender paid it, it's fixed now; otherwise Atlas asks the payer to confirm first.",
    parameters: {
      type: "object",
      properties: {
        expense_number: { type: "integer", description: "the #n from the log message" },
        amount_usd: { type: "number", description: "corrected total" },
        exclude: { type: "array", items: { type: "string" }, description: "people who shouldn't share it" },
        remove: { type: "boolean" },
      },
      required: ["expense_number"],
    },
  },
  sideEffects: true,
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const n = num(args.expense_number);
    const old = n ? await expenseNumber(tc.trip.id, n) : undefined;
    if (!old || old.status !== "active") throw new ToolError(`there's no active expense #${n}`);
    const amountCents = num(args.amount_usd) ? Math.round(num(args.amount_usd)! * 100) : undefined;
    const exclude = strList(args.exclude).map((x) => tc.resolve(x)).filter((x): x is number => x !== undefined);
    const splitIds = exclude.length ? Object.keys(old.shares).map(Number).filter((id) => !exclude.includes(id)) : undefined;
    if (!args.remove && amountCents === undefined && !splitIds) throw new ToolError("nothing to change: give amount_usd, exclude, or remove");
    if (tc.senderId === old.payer_id) {
      if (args.remove) {
        await tc.nonCancellable();
        await voidExpense(old.id);
        await undoInNessie(old);
        const text = `removed #${n} (${old.description})`;
        say(tc, text);
        return { ok: true, posted: [text] };
      }
      const text = await fixExpense(tc, old, { amountCents, splitIds }, `fix:${old.id}:m${tc.sourceMessageId}`);
      say(tc, text);
      return { ok: true, posted: [text] };
    }
    // Someone else is disputing: the payer decides.
    await q(`INSERT INTO confirmations (chat_id, person_id, kind, payload, created_at) VALUES ($1,$2,'expense_fix',$3,$4)`, [
      tc.chat.id,
      old.payer_id,
      JSON.stringify({ expenseId: old.id, amountCents, splitIds, remove: Boolean(args.remove) }),
      tc.now,
    ]);
    const what = args.remove ? "remove it" : amountCents !== undefined ? `make it ${formatUsd(amountCents, { cents: "always" })}` : `leave ${exclude.map((x) => tc.label(x).toLowerCase()).join(" + ")} out of it`;
    if (amountCents !== undefined) tc.figures.add({ cents: amountCents, label: "disputed amount", source: "user:stated", visibility: "public" });
    tc.figures.add({ cents: old.amount_cents, label: `expense #${n}`, source: `ledger:${old.id}`, visibility: "public" });
    const text = `${tc.label(old.payer_id).toLowerCase()}, ${tc.senderId !== null ? tc.label(tc.senderId).toLowerCase() : "someone"} wants to ${what} for #${n} (${old.description}, ${formatUsd(old.amount_cents, { cents: "always" })}). reply "yes" to fix it or "no" to keep it`;
    say(tc, text);
    return { ok: true, posted: [text], next: "the payer has to confirm; don't change anything yet" };
  },
};

const balancesTool: Tool = {
  soloPost: true,
  decl: { name: "show_balances", description: "Post who owes whom right now (fewest transfers). Posts its own message.", parameters: { type: "object", properties: {} } },
  async run(_args, ctx) {
    const lines = await balanceLines(ctx as TurnCtx);
    say(ctx, lines.join("\n"));
    return { ok: true, posted: lines };
  },
};

const settleTool: Tool = {
  decl: { name: "propose_settle_up", description: "Propose the settle-up: the fewest transfers that square everyone, then each payer confirms and it's sent as a transfer from their checking. Posts its own messages.", parameters: { type: "object", properties: {} } },
  sideEffects: true,
  async run(_args, ctx) {
    await proposeSettleUp(ctx as TurnCtx);
    return { ok: true, next: "posted; payers confirm by replying confirm" };
  },
};

const splitModeTool: Tool = {
  soloPost: true,
  sideEffects: true,
  decl: {
    name: "set_cost_split",
    description:
      "Change how the trip fund is shared and re-post its plan. \"even\" = everyone puts in one equal share (when people say everyone should pay the same); \"by_cost\" = each shared cost is split only among the people it's for. Travel is always each person's own. Posts its own messages.",
    parameters: { type: "object", properties: { mode: { type: "string", enum: ["even", "by_cost"] } }, required: ["mode"] },
  },
  async run(args, ctx) {
    const mode = args.mode === "even" ? "even" : args.mode === "by_cost" ? "by_cost" : undefined;
    if (!mode) throw new ToolError('mode must be "even" or "by_cost"');
    await setSplitMode(ctx as TurnCtx, mode);
    return { ok: true, next: "the new plan was posted; NO_REPLY or one short line" };
  },
};

// ---------- feature ----------

export const moneyFeature: Feature = {
  name: "money",
  tools: [logExpenseTool, correctExpenseTool, balancesTool, settleTool, splitModeTool],

  async fastPath(msg, tc) {
    if (await resolveConfirmation(msg, tc)) return true;
    if (msg.kind !== "text" || msg.person_id === null || !msg.speakable) return false;
    if (tc.trip.status === "planning" || tc.trip.status === "voting" || tc.trip.status === "done") return false;
    const names = tc.members.map((m) => tc.label(m.id).toLowerCase().split(/\s+/)[0]!);
    const parsed = parseExpense(msg.text, names);
    if (!parsed || parsed.confidence !== "high") return false;
    tc.senderId = msg.person_id;
    tc.sourceMessageId = msg.id;
    const splitIds = parsed.splitAmong ? parsed.splitAmong.map((n) => (n === "me" ? msg.person_id! : tc.resolve(n))).filter((x): x is number => x !== undefined) : null;
    try {
      const { text, duplicate } = await logExpense(tc, { payerId: msg.person_id, amountCents: parsed.amountCents, description: parsed.description || "expense", splitIds, key: `exp:${msg.id}:0`, sourceMessageId: msg.id });
      if (!duplicate) {
        const stay = await stayFromExpense(tc, parsed.description, parsed.amountCents);
        say(tc, stay ? `${text}\n${stay}` : text);
      }
      return true;
    } catch (err) {
      if (err instanceof ToolError) return false;
      throw err;
    }
  },

  commands: {
    balances: async (_msg, tc) => {
      say(tc, (await balanceLines(tc)).join("\n"));
    },
    settle_up: async (_msg, tc) => proposeSettleUp(tc),
    split_mode: async (_msg, tc, cmd) => {
      if (cmd.kind === "split_mode") await setSplitMode(tc, cmd.mode);
    },
  },

  async figures(tc) {
    const out: Figure[] = [];
    for (const e of await activeExpenses(tc.trip.id)) out.push(...expenseFigures(e));
    for (const s of await openSettlements(tc.trip.id)) out.push({ cents: s.amount_cents, label: "settle-up transfer", source: "ledger:settle-up", visibility: "public" });
    const spent = await spentSoFar(tc.trip.id);
    if (spent.totalCents) out.push({ cents: spent.totalCents, label: "spent so far", source: "tiger:trip_spend_daily", visibility: "public" });
    const b = await tripBalances(tc.trip.id, tc.members.map((m) => m.id));
    for (const p of b.plan) out.push({ cents: p.amountCents, label: `${tc.label(p.from)} owes ${tc.label(p.to)}`, source: "ledger:balances", visibility: "public" });
    return out;
  },

  async situation(tc) {
    const expenses = await activeExpenses(tc.trip.id);
    const lines: string[] = [];
    for (const e of expenses.slice(-10)) lines.push(`#${await numberOf(e)} ${e.description} ${formatUsd(e.amount_cents, { cents: "always" })} paid by ${tc.label(e.payer_id)}, shares ${Object.entries(e.shares).map(([id, c]) => `${tc.label(Number(id))} ${formatUsd(c, { cents: "always" })}`).join(", ")}${e.nessie_purchase_id ? " [synced]" : ""}`);
    if (expenses.length) lines.push(...(await balanceLines(tc)));
    const spent = await spentSoFar(tc.trip.id);
    if (spent.totalCents) lines.push(`spent so far (from the trip_spend_daily aggregate): ${formatUsd(spent.totalCents, { cents: "always" })}`);
    const settlements = await openSettlements(tc.trip.id);
    if (settlements.length) lines.push(`settle-up in progress: ${settlements.map((s) => `${tc.label(s.from_id)} → ${tc.label(s.to_id)} ${formatUsd(s.amount_cents, { cents: "always" })} (${s.status})`).join("; ")}`);
    const pending = await q<{ person_id: number; kind: string }>(`SELECT person_id, kind FROM confirmations WHERE chat_id = $1 AND status = 'pending'`, [tc.chat.id]);
    if (pending.length) lines.push(`waiting on confirmation from: ${pending.map((p) => `${tc.label(p.person_id)} (${p.kind})`).join(", ")}`);
    return lines.length ? { title: "trip money (exact ledger)", lines } : null;
  },

  async summary(tc) {
    const spent = await spentSoFar(tc.trip.id);
    const out: string[] = [];
    if (spent.totalCents) out.push(`spent so far: ${formatUsd(spent.totalCents, { cents: "always" })}`);
    const b = await tripBalances(tc.trip.id, tc.members.map((m) => m.id));
    if (b.plan.length) out.push(`owed: ${b.plan.map((p) => `${tc.label(p.from).toLowerCase()} → ${tc.label(p.to).toLowerCase()} ${formatUsd(p.amountCents, { cents: "always" })}`).join(", ")}`);
    return out;
  },

  async hints(tc) {
    const out: string[] = [];
    if (tc.trip.end_date && tc.trip.status === "settling") out.push("the trip is over: time to settle up if nobody has");
    const due = await one<{ n: number }>(`SELECT count(*)::int AS n FROM fund_txns WHERE trip_id = $1 AND kind = 'contribution' AND status = 'scheduled' AND due_date = $2`, [tc.trip.id, addDays(tc.today, 1)]);
    if ((due?.n ?? 0) > 0) out.push("trip-fund contributions go in tomorrow");
    return out;
  },

  jobs(svc: AppServices) {
    return {
      "nessie.sync_expense": async (payload) => {
        const e = await one<ExpenseRow>(`SELECT * FROM expenses WHERE id = $1`, [Number(payload.expenseId)]);
        if (!e || e.nessie_purchase_id || e.status !== "active") return;
        await pushNessiePurchase(e, Object.keys(e.shares).length);
      },
      "settle.execute": async (payload, { jobId }) => {
        const s = await one<SettlementRow>(`SELECT * FROM settlements WHERE id = $1`, [Number(payload.settlementId)]);
        if (!s || s.status === "executed") return;
        const chatId = Number(payload.chatId);
        const members = await activeMembers(chatId);
        const byId = new Map(members.map((m) => [m.id, m]));
        const label = (id: number | null) => labelOf(byId.get(id ?? -1) ?? { display_name: null, handle: null });
        const text = await executeSettlement(s, label);
        await svc.post(chatId, `settle${jobId}`, [{ type: "say", text }]);
        const open = await openSettlements(s.trip_id);
        if (open.length === 0) {
          await updateTrip(s.trip_id, { status: "done" });
          await svc.post(chatId, `settled${jobId}`, [{ type: "say", text: "and that's everyone, all settled up 🎉" }]);
        }
      },
    };
  },
};

export { proposeSettleUp };
