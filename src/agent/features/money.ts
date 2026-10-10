// Trip money through Nessie, end to end:
//   (a) each person's share and (b) a payment plan as Nessie bills timed to their paydays;
//   (c) "i paid 64 for dinner" → a Nessie purchase on the payer's account + an exact-cents ledger
//       row (idempotent by source message), disputes fixed only with the payer's confirmation;
//   (d) settle-up with the fewest transfers, each executed as a Nessie transfer only after the
//       person paying confirms in the chat.
// All arithmetic is deterministic code; every figure posted is registered for the money guard.
import { addDays, now } from "../../clock.ts";
import { childLog } from "../../log.ts";
import { formatUsd } from "../../money/cents.ts";
import { PAYCHECK_PATTERN } from "../../money/budget.ts";
import { inferPaycheckCadence, planInstallments } from "../../money/paymentPlan.ts";
import { splitByItems, splitEvenly } from "../../money/split.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, labelOf, type MessageRow } from "../../db/repos/core.ts";
import { enqueueJob } from "../../pipeline/jobs.ts";
import { capabilities, nessieAmount } from "../../nessie/capabilities.ts";
import { readLedger } from "../../nessie/ledger.ts";
import { linkFor, sharedNessie, tripMerchant } from "../../nessie/seed.ts";
import { parseExpense } from "../../trips/expenseParse.ts";
import { activeExpenses, categorize, expenseByKey, expenseNumber, insertExpense, numberOf, openSettlements, proposeSettlements, setExpenseNessie, spentSoFar, tripBalances, voidExpense, type ExpenseRow, type SettlementRow } from "../../trips/ledger.ts";
import { updateTrip, type TripRow } from "../../trips/state.ts";
import { destinationById } from "../../trips/catalog.ts";
import { buildConstraints } from "../../trips/constraints.ts";
import { estimateCost } from "../../trips/estimate.ts";
import { budgetRows } from "../../nessie/budgets.ts";
import type { AppServices, Feature, TurnCtx } from "../feature.ts";
import { nameList } from "./planning.ts";
import type { Figure } from "../figures.ts";
import { ToolError, num, say, str, strList, type Tool } from "../tools.ts";

const log = () => childLog({ component: "money" });
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();

// ---------- (a)+(b) shares and payment plan ----------

type PerPersonCost = { totalCents: number; transportMode?: "flight" | "drive" };

async function sharesFor(trip: TripRow, memberIds: number[]): Promise<{ shares: Map<number, number>; modes: Map<number, string> }> {
  const row = await one<{ options: { destId: string; avgCents: number; perPerson: Record<string, PerPersonCost> }[] }>(
    `SELECT options FROM proposals WHERE trip_id = $1 ORDER BY id DESC LIMIT 1`,
    [trip.id],
  );
  const option = row?.options.find((o) => o.destId === trip.destination_id);
  const shares = new Map<number, number>();
  const modes = new Map<number, string>();
  for (const id of memberIds) {
    const cost = option?.perPerson[String(id)];
    const cents = cost?.totalCents ?? option?.avgCents;
    if (cents) shares.set(id, Math.round(cents / 500) * 500);
    if (cost?.transportMode) modes.set(id, cost.transportMode);
  }
  return { shares, modes };
}

/** One equal share each: the group's total split evenly, rounded to $5 like every estimate. */
export function evenShares(shares: Map<number, number>): Map<number, number> {
  if (shares.size === 0) return shares;
  const total = [...shares.values()].reduce((a, b) => a + b, 0);
  const each = Math.round(total / shares.size / 500) * 500;
  return new Map([...shares.keys()].map((id) => [id, each]));
}

/** "4 payments of $173.75" when they're equal, otherwise each amount with its date. */
export function installmentLines(plan: { dueDate: string; amountCents: number }[]): string[] {
  if (plan.length === 0) return [];
  const same = plan.every((p) => p.amountCents === plan[0]!.amountCents);
  if (same) {
    const what = plan.length === 1 ? `1 payment of ${formatUsd(plan[0]!.amountCents)}` : `${plan.length} payments of ${formatUsd(plan[0]!.amountCents)}`;
    return [what, plan.map((p) => day(p.dueDate)).join(", ")];
  }
  return plan.map((p) => `${day(p.dueDate)}: ${formatUsd(p.amountCents)}`);
}

/** Why the shares aren't equal, in one line (travel is the only thing that differs per person). */
function whyDifferent(shares: Map<number, number>, modes: Map<number, string>, label: (id: number) => string): string | null {
  if (new Set(shares.values()).size <= 1) return null;
  const drivers = [...shares.keys()].filter((id) => modes.get(id) === "drive").map((id) => label(id).toLowerCase());
  const flyers = [...shares.keys()].filter((id) => modes.get(id) === "flight").map((id) => label(id).toLowerCase());
  const travel =
    drivers.length && flyers.length
      ? `${nameList(drivers)} ${drivers.length === 1 ? "drives" : "drive"}, ${flyers.length === shares.size - drivers.length ? "everyone else flies" : `${nameList(flyers)} fly`}`
      : "flights cost different amounts from each home city";
  return `shares differ because travel does (${travel}).\nwant one equal share instead? say "split it evenly"`;
}

async function setupPaymentPlan(tc: TurnCtx): Promise<void> {
  const trip = tc.trip;
  if (!trip.start_date) return;
  const mode = trip.split_mode ?? "by_cost";
  let { shares, modes } = await sharesFor(trip, tc.members.map((m) => m.id));
  if (shares.size === 0) shares = await estimatedShares(tc);
  if (shares.size === 0) return;
  if (mode === "even") shares = evenShares(shares);
  await tc.nonCancellable();
  const today = tc.today;
  let deadline = trip.deposit_deadline ?? addDays(trip.start_date, -7);
  if (deadline <= today) deadline = addDays(today, 1);
  const client = sharedNessie();
  // by_cost keeps the original key shape so plans posted before split modes existed aren't duplicated.
  const keyFor = (personId: number, i: number) => (mode === "even" ? `inst:${trip.id}:even:${personId}:${i}` : `inst:${trip.id}:${personId}:${i}`);
  await cancelOtherPlan(trip, mode, client);
  const bubbles: string[] = [];
  let offline = !client;
  for (const [personId, shareCents] of shares) {
    const link = await linkFor(personId);
    let paydays: string[] = [];
    if (link?.seed_status === "ready") {
      const ledger = await readLedger(link, client);
      if (ledger.source === "offline-profile") offline = true;
      const pay = ledger.txns.filter((t) => t.kind === "deposit" && PAYCHECK_PATTERN.test(t.description)).map((t) => t.date);
      paydays = inferPaycheckCadence(pay).nextPaydays(addDays(today, 1), deadline);
    }
    const plan = planInstallments({ shareCents, today, deadline, paydays });
    for (const [i, inst] of plan.entries()) {
      const key = keyFor(personId, i);
      const existing = await one<{ id: number; nessie_bill_id: string | null }>(`SELECT id, nessie_bill_id FROM installments WHERE idempotency_key = $1`, [key]);
      let billId = existing?.nessie_bill_id ?? null;
      if (!existing) await q(`INSERT INTO installments (trip_id, person_id, due_date, amount_cents, idempotency_key, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [trip.id, personId, inst.dueDate, inst.amountCents, key, now()]);
      else await q(`UPDATE installments SET status = 'scheduled' WHERE id = $1 AND status = 'cancelled'`, [existing.id]);
      if (!billId && client && link?.checking_id && !link.seed_progress.offline) {
        try {
          billId = (
            await client.createOn(
              link.checking_id,
              "bills",
              {
                status: "pending",
                payee: `[atlas] ${trip.destination_name} trip fund`,
                nickname: `[atlas] ${trip.destination_name} trip ${i + 1}/${plan.length}`,
                payment_date: inst.dueDate,
                recurring_date: Number(inst.dueDate.slice(8, 10)),
                payment_amount: inst.amountCents / 100,
              },
              personId,
            )
          ).id;
          await q(`UPDATE installments SET nessie_bill_id = $2 WHERE idempotency_key = $1`, [key, billId]);
        } catch (err) {
          log().warn({ err: (err as Error).message }, "could not create nessie bill; installment kept locally");
        }
      }
      tc.figures.add({ cents: inst.amountCents, label: `${tc.label(personId)} installment`, source: billId ? `nessie:${billId}` : "estimate:plan", visibility: "public" });
    }
    tc.figures.add({ cents: shareCents, label: `${tc.label(personId)}'s share (est.)`, source: "estimate:proposal", visibility: "public" });
    bubbles.push([`${tc.label(personId).toLowerCase()}: ${formatUsd(shareCents)} total`, ...installmentLines(plan)].join("\n"));
  }
  const where = offline ? "estimates, demo profiles are offline so it's tracked here" : "estimates, set up as bills in your demo nessie accounts";
  const header = `💸 payment plan${mode === "even" ? ", split evenly" : ""}\nsmall payments on your paydays, all done by ${day(deadline)}\n(${where})`;
  const footer = mode === "even" ? `everyone pays the same now. "split by cost" switches back` : whyDifferent(shares, modes, (id) => tc.label(id));
  say(tc, header, ...bubbles, ...(footer ? [footer] : []));
}

/** Switching split modes retires the other plan's installments (and their Nessie bills). */
async function cancelOtherPlan(trip: TripRow, mode: "by_cost" | "even", client: ReturnType<typeof sharedNessie>): Promise<void> {
  const stale = await q<{ id: number; person_id: number; nessie_bill_id: string | null }>(
    `UPDATE installments SET status = 'cancelled' WHERE trip_id = $1 AND status = 'scheduled'
       AND (CASE WHEN $2 = 'even' THEN idempotency_key NOT LIKE $3 ELSE idempotency_key LIKE $3 END)
     RETURNING id, person_id, nessie_bill_id`,
    [trip.id, mode, `inst:${trip.id}:even:%`],
  );
  if (!client) return;
  for (const s of stale) {
    if (!s.nessie_bill_id) continue;
    try {
      await client.remove(`/bills/${s.nessie_bill_id}`, s.person_id);
    } catch (err) {
      log().warn({ err: (err as Error).message }, "could not remove a retired nessie bill");
    }
  }
}

/** Change how the trip is shared and re-post the plan. */
export async function setSplitMode(tc: TurnCtx, mode: "by_cost" | "even"): Promise<void> {
  if (!tc.trip.destination_id || !tc.trip.start_date) {
    tc.trip = await updateTrip(tc.trip.id, { split_mode: mode });
    say(tc, mode === "even" ? "got it, everyone pays the same. i'll split it evenly once we lock a place" : "got it, everyone covers their own travel. i'll split it that way once we lock a place");
    return;
  }
  if (tc.trip.split_mode === mode) {
    await setupPaymentPlan(tc);
    return;
  }
  await tc.nonCancellable();
  tc.trip = await updateTrip(tc.trip.id, { split_mode: mode });
  await setupPaymentPlan(tc);
}

/** No proposal behind this destination (locked by name): estimate each share from the catalog. */
async function estimatedShares(tc: TurnCtx): Promise<Map<number, number>> {
  const dest = tc.trip.destination_id ? destinationById(tc.trip.destination_id) : undefined;
  if (!dest || !tc.trip.start_date || !tc.trip.end_date) return new Map();
  const built = buildConstraints(await tc.view(), await budgetRows(tc.trip.id), { tripStart: tc.trip.start_date, tripEnd: tc.trip.end_date });
  const out = new Map<number, number>();
  for (const m of built.group.members) {
    const c = estimateCost(dest, m, built.group.nights, built.group.tier, built.group.members.length);
    out.set(m.personId, Math.round(c.totalCents / 500) * 500);
  }
  return out;
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
    return `split ${entries.length} ways${others.length ? `: ${nameList(others.map(([id]) => tc.label(id).toLowerCase()))} owe ${tc.label(expense.payer_id).toLowerCase()} ${formatUsd(others[0]![1], { cents: "always" })} each` : ""}`;
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
  const text = `logged #${n}: ${fresh.description} ${formatUsd(fresh.amount_cents, { cents: "always" })}, paid by ${tc.label(fresh.payer_id).toLowerCase()}${inNessie ? " (nessie purchase ✓)" : sharedNessie() ? " (syncing to nessie)" : ""}. ${describeSplit(fresh, tc)}`;
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

async function proposeSettleUp(tc: TurnCtx): Promise<void> {
  const b = await tripBalances(tc.trip.id, tc.members.map((m) => m.id));
  if (b.count === 0) {
    say(tc, "nothing to settle yet, no shared expenses logged");
    return;
  }
  if (b.plan.length === 0) {
    say(tc, "everyone's already even 🎉");
    return;
  }
  await tc.nonCancellable();
  const rows = await proposeSettlements(tc.trip.id, b.plan);
  await q(`UPDATE confirmations SET status = 'expired', resolved_at = $2 WHERE chat_id = $1 AND kind = 'settlement' AND status = 'pending'`, [tc.chat.id, tc.now]);
  const payers = [...new Set(rows.map((r) => r.from_id))];
  for (const p of payers) {
    await q(`INSERT INTO confirmations (chat_id, person_id, kind, payload, created_at) VALUES ($1,$2,'settlement',$3,$4)`, [tc.chat.id, p, JSON.stringify({ planId: rows[0]!.plan_id }), tc.now]);
  }
  if (tc.trip.status !== "done") tc.trip = await updateTrip(tc.trip.id, { status: "settling" });
  for (const r of rows) tc.figures.add({ cents: r.amount_cents, label: `${tc.label(r.from_id)} pays ${tc.label(r.to_id)}`, source: "ledger:settle-up", visibility: "public" });
  say(
    tc,
    `settle-up, the fewest transfers that square everything (${rows.length}):\n${rows.map((r) => `${tc.label(r.from_id).toLowerCase()} → ${tc.label(r.to_id).toLowerCase()} ${formatUsd(r.amount_cents, { cents: "always" })}`).join("\n")}`,
    `${nameList(payers.map((p) => tc.label(p).toLowerCase()))}, reply "confirm" and i'll send yours as a nessie transfer (sandbox money, nothing real moves)`,
  );
}

async function executeSettlement(s: SettlementRow, label: (id: number) => string): Promise<string> {
  const client = sharedNessie();
  const [from, to] = await Promise.all([linkFor(s.from_id), linkFor(s.to_id)]);
  await q(`UPDATE settlements SET status = 'executing' WHERE id = $1`, [s.id]);
  const description = `[atlas] settle-up ${label(s.from_id)} to ${label(s.to_id)} ${formatUsd(s.amount_cents, { cents: "always" })} (${s.idempotency_key})`;
  const at = now().toISOString().slice(0, 10);
  if (!client || !from?.checking_id || !to?.checking_id || from.seed_progress.offline || to.seed_progress.offline) {
    await q(`UPDATE settlements SET status = 'executed', executed_at = $2, last_error = 'offline: recorded only' WHERE id = $1`, [s.id, now()]);
    return `✓ ${label(s.from_id).toLowerCase()} → ${label(s.to_id).toLowerCase()} ${formatUsd(s.amount_cents, { cents: "always" })} recorded (demo profiles offline, so no nessie transfer)`;
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
    return `✓ sent: ${label(s.from_id).toLowerCase()} → ${label(s.to_id).toLowerCase()} ${formatUsd(s.amount_cents, { cents: "always" })} (nessie transfer ✓)`;
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
      say(tc, `nessie isn't answering right now, i'll send ${tc.label(s.from_id).toLowerCase()} → ${tc.label(s.to_id).toLowerCase()} as soon as it's back`);
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

// ---------- tools ----------

const logExpenseTool: Tool = {
  decl: {
    name: "log_expense",
    description:
      "Log a shared trip expense the SENDER paid (\"i covered the boat for me, leo and priya\", itemized receipts). Never log prices people are only discussing, or what someone else paid. Posts its own confirmation.",
    parameters: {
      type: "object",
      properties: {
        amount_usd: { type: "number" },
        description: { type: "string" },
        split_among: { type: "array", items: { type: "string" }, description: "first names incl. the payer (\"me\"); omit for everyone" },
        items: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, amount_usd: { type: "number" }, shared_by: { type: "array", items: { type: "string" } } }, required: ["name", "amount_usd", "shared_by"] },
          description: "per-item lines; tax/tip/fees left over are shared in proportion",
        },
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
    say(tc, text);
    return { ok: true, posted: [text] };
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
  decl: { name: "propose_settle_up", description: "Propose the settle-up: the fewest transfers that square everyone, then each payer confirms and it's sent through Nessie. Posts its own messages.", parameters: { type: "object", properties: {} } },
  sideEffects: true,
  async run(_args, ctx) {
    await proposeSettleUp(ctx as TurnCtx);
    return { ok: true, next: "posted; payers confirm by replying confirm" };
  },
};

const paymentPlanTool: Tool = {
  decl: { name: "show_payment_plan", description: "Post (or re-post) each person's share and their installment plan (Nessie bills timed to paydays).", parameters: { type: "object", properties: {} } },
  sideEffects: true,
  async run(_args, ctx) {
    const tc = ctx as TurnCtx;
    if (!tc.trip.destination_id) throw new ToolError("no destination locked yet");
    await setupPaymentPlan(tc);
    return { ok: true, next: "posted" };
  },
};

const splitModeTool: Tool = {
  soloPost: true,
  sideEffects: true,
  decl: {
    name: "set_cost_split",
    description:
      "Change how the trip's cost is shared and re-post the payment plan. \"even\" = everyone pays one equal share (when people say everyone should pay the same); \"by_cost\" = each person covers their own travel. Posts its own messages.",
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
  tools: [logExpenseTool, correctExpenseTool, balancesTool, settleTool, paymentPlanTool, splitModeTool],

  async onTripLocked(_trip, tc) {
    await setupPaymentPlan(tc);
  },

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
      if (!duplicate) say(tc, text);
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
    const inst = await q<{ amount_cents: number; nessie_bill_id: string | null }>(`SELECT amount_cents, nessie_bill_id FROM installments WHERE trip_id = $1`, [tc.trip.id]);
    for (const i of inst) out.push({ cents: i.amount_cents, label: "installment", source: i.nessie_bill_id ? `nessie:${i.nessie_bill_id}` : "estimate:plan", visibility: "public" });
    const spent = await spentSoFar(tc.trip.id);
    if (spent.totalCents) out.push({ cents: spent.totalCents, label: "spent so far", source: "tiger:trip_spend_daily", visibility: "public" });
    const b = await tripBalances(tc.trip.id, tc.members.map((m) => m.id));
    for (const p of b.plan) out.push({ cents: p.amountCents, label: `${tc.label(p.from)} owes ${tc.label(p.to)}`, source: "ledger:balances", visibility: "public" });
    return out;
  },

  async situation(tc) {
    const expenses = await activeExpenses(tc.trip.id);
    const lines: string[] = [];
    for (const e of expenses.slice(-10)) lines.push(`#${await numberOf(e)} ${e.description} ${formatUsd(e.amount_cents, { cents: "always" })} paid by ${tc.label(e.payer_id)}, shares ${Object.entries(e.shares).map(([id, c]) => `${tc.label(Number(id))} ${formatUsd(c, { cents: "always" })}`).join(", ")}${e.nessie_purchase_id ? " [nessie]" : ""}`);
    if (expenses.length) lines.push(...(await balanceLines(tc)));
    const spent = await spentSoFar(tc.trip.id);
    if (spent.totalCents) lines.push(`spent so far (from the trip_spend_daily aggregate): ${formatUsd(spent.totalCents, { cents: "always" })}`);
    const settlements = await openSettlements(tc.trip.id);
    if (settlements.length) lines.push(`settle-up in progress: ${settlements.map((s) => `${tc.label(s.from_id)} → ${tc.label(s.to_id)} ${formatUsd(s.amount_cents, { cents: "always" })} (${s.status})`).join("; ")}`);
    const pending = await q<{ person_id: number; kind: string }>(`SELECT person_id, kind FROM confirmations WHERE chat_id = $1 AND status = 'pending'`, [tc.chat.id]);
    if (pending.length) lines.push(`waiting on confirmation from: ${pending.map((p) => `${tc.label(p.person_id)} (${p.kind})`).join(", ")}`);
    return lines.length ? { title: "trip money (exact ledger; nessie is the system of record)", lines } : null;
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
    const due = await one<{ n: number }>(`SELECT count(*)::int AS n FROM installments WHERE trip_id = $1 AND status = 'scheduled' AND due_date = $2`, [tc.trip.id, addDays(tc.today, 1)]);
    if ((due?.n ?? 0) > 0) out.push("payment-plan installments are due tomorrow");
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

export { setupPaymentPlan, proposeSettleUp };
