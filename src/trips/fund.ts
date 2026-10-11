// The trip fund in Postgres and Nessie. One fund per trip:
//   - a Nessie customer "<Trip> Trip Fund" with a checking account (created on first use),
//   - fund_items: what it pays for (the stay, plus anything the group marks shared),
//   - fund_txns: contributions (each person's checking → fund, on their paydays before the
//     deposit deadline), refunds (fund → checking, the leftover at settle-up) and purchases
//     (fund → a merchant named after the stay or item).
// Every movement is a ledger row first; a Nessie transfer/purchase backs it when there's a key,
// a fund account and (for a person) a connected bank. Otherwise it's tracked in the ledger only
// (via = 'ledger'), so the fund works offline and for people who never connected.
import { createHash } from "node:crypto";
import { addDays, now } from "../clock.ts";
import { childLog } from "../log.ts";
import { one, q } from "../db/pool.ts";
import { fundShares } from "../money/fund.ts";
import { PAYCHECK_PATTERN } from "../money/budget.ts";
import { inferPaycheckCadence, planInstallments } from "../money/paymentPlan.ts";
import { capabilities, nessieAmount } from "../nessie/capabilities.ts";
import type { NessieClient } from "../nessie/client.ts";
import { readLedger } from "../nessie/ledger.ts";
import { linkFor, sharedNessie } from "../nessie/seed.ts";
import type { TripRow } from "./state.ts";

const log = () => childLog({ component: "fund" });

/** Contributions are due this many days before the trip starts. */
export const DEPOSIT_LEAD_DAYS = 14;

export interface FundRow {
  trip_id: number;
  nessie_customer_id: string | null;
  nessie_account_id: string | null;
  deadline: string | null;
  created_at: Date;
}

export interface FundItemRow {
  id: number;
  trip_id: number;
  kind: "stay" | "item";
  description: string;
  amount_cents: number;
  shared_by: number[] | null;
  status: "active" | "removed";
  paid_at: Date | null;
  nessie_merchant_id: string | null;
  nessie_purchase_id: string | null;
  idempotency_key: string;
  created_at: Date;
}

export interface FundTxnRow {
  id: number;
  trip_id: number;
  person_id: number | null;
  kind: "contribution" | "refund" | "purchase";
  amount_cents: number;
  due_date: string | null;
  status: "scheduled" | "done" | "cancelled" | "failed";
  via: "bank" | "ledger" | null;
  item_id: number | null;
  plan_key: string | null;
  nessie_transfer_id: string | null;
  nessie_deposit_id: string | null;
  idempotency_key: string;
  executed_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

export async function getFund(tripId: number): Promise<FundRow | undefined> {
  return one<FundRow>(`SELECT * FROM trip_funds WHERE trip_id = $1`, [tripId]);
}

export async function fundItems(tripId: number): Promise<FundItemRow[]> {
  return q<FundItemRow>(`SELECT * FROM fund_items WHERE trip_id = $1 AND status = 'active' ORDER BY (kind = 'stay') DESC, id`, [tripId]);
}

export async function fundTxns(tripId: number, statuses: FundTxnRow["status"][] = ["scheduled", "done"]): Promise<FundTxnRow[]> {
  return q<FundTxnRow>(`SELECT * FROM fund_txns WHERE trip_id = $1 AND status = ANY($2::text[]) ORDER BY COALESCE(executed_at, created_at), id`, [tripId, statuses]);
}

/** Done amounts per person for one kind (contributions in, refunds out). */
export async function doneBy(tripId: number, kind: "contribution" | "refund"): Promise<Map<number, number>> {
  const rows = await q<{ person_id: number; total: number }>(
    `SELECT person_id, sum(amount_cents)::bigint AS total FROM fund_txns WHERE trip_id = $1 AND kind = $2 AND status = 'done' AND person_id IS NOT NULL GROUP BY person_id`,
    [tripId, kind],
  );
  return new Map(rows.map((r) => [Number(r.person_id), Number(r.total)]));
}

export interface FundTotals {
  targetCents: number;
  /** Contributions in minus refunds out. */
  collectedCents: number;
  /** Purchases the fund made. */
  spentCents: number;
  /** What the account holds now. */
  balanceCents: number;
}

export async function fundTotals(tripId: number): Promise<FundTotals> {
  const row = await one<{ target: number; contributed: number; refunded: number; spent: number }>(
    `SELECT (SELECT COALESCE(sum(amount_cents), 0) FROM fund_items WHERE trip_id = $1 AND status = 'active')::bigint AS target,
            COALESCE(sum(amount_cents) FILTER (WHERE kind = 'contribution'), 0)::bigint AS contributed,
            COALESCE(sum(amount_cents) FILTER (WHERE kind = 'refund'), 0)::bigint AS refunded,
            COALESCE(sum(amount_cents) FILTER (WHERE kind = 'purchase'), 0)::bigint AS spent
       FROM fund_txns WHERE trip_id = $1 AND status = 'done'`,
    [tripId],
  );
  const collected = Number(row?.contributed ?? 0) - Number(row?.refunded ?? 0);
  const spent = Number(row?.spent ?? 0);
  return { targetCents: Number(row?.target ?? 0), collectedCents: collected, spentCents: spent, balanceCents: collected - spent };
}

/** The deposit deadline: two weeks before the trip, never today or earlier. */
export function depositDeadline(startDate: string, today: string): string {
  const d = addDays(startDate, -DEPOSIT_LEAD_DAYS);
  return d > today ? d : addDays(today, 1);
}

/** "Tahoe Trip Fund" from the trip's title or destination. */
export function fundName(trip: Pick<TripRow, "title" | "destination_name">): string {
  const base = (trip.title ?? trip.destination_name ?? "Group").split(",")[0]!.trim();
  const titled = base.replace(/\b\p{L}/gu, (c) => c.toUpperCase()).replace(/\s+trip$/i, "");
  return `${titled} Trip Fund`;
}

export async function ensureFundRow(tripId: number, deadline: string | null): Promise<FundRow> {
  await q(
    `INSERT INTO trip_funds (trip_id, deadline, created_at, updated_at) VALUES ($1,$2,$3,$3)
     ON CONFLICT (trip_id) DO UPDATE SET deadline = COALESCE(EXCLUDED.deadline, trip_funds.deadline), updated_at = EXCLUDED.updated_at`,
    [tripId, deadline, now()],
  );
  return (await getFund(tripId))!;
}

/**
 * The fund's Nessie customer and account, created once. Returns null when there's no key or
 * Nessie is unreachable (the fund is then tracked in Atlas's ledger only; a later call retries).
 */
export async function ensureFundAccount(trip: TripRow, client: NessieClient | null = sharedNessie()): Promise<string | null> {
  const fund = await ensureFundRow(trip.id, null);
  if (fund.nessie_account_id) return fund.nessie_account_id;
  if (!client) return null;
  try {
    const name = fundName(trip);
    let customerId = fund.nessie_customer_id;
    if (!customerId) {
      customerId = (
        await client.createCustomer({
          first_name: name.replace(/ Trip Fund$/, ""),
          last_name: "Trip Fund",
          address: { street_number: "100", street_name: "Main Street", city: "Chapel Hill", state: "NC", zip: "27514" },
        })
      ).id;
      await q(`UPDATE trip_funds SET nessie_customer_id = $2, updated_at = $3 WHERE trip_id = $1`, [trip.id, customerId, now()]);
    }
    const accountId = (await client.createAccount(customerId, { type: "Checking", nickname: name, rewards: 0, balance: 0 })).id;
    await q(`UPDATE trip_funds SET nessie_account_id = $2, updated_at = $3 WHERE trip_id = $1`, [trip.id, accountId, now()]);
    return accountId;
  } catch (err) {
    log().warn({ err: (err as Error).message, tripId: trip.id }, "could not open the nessie fund account; tracking in the ledger");
    return null;
  }
}

export async function addFundItem(i: { tripId: number; kind: "stay" | "item"; description: string; amountCents: number; sharedBy?: number[] | null; key: string; sourceMessageId?: number | null }): Promise<{ item: FundItemRow; created: boolean }> {
  const row = await one<FundItemRow>(
    `INSERT INTO fund_items (trip_id, kind, description, amount_cents, shared_by, idempotency_key, source_message_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [i.tripId, i.kind, i.description.slice(0, 80), i.amountCents, i.sharedBy?.length ? JSON.stringify(i.sharedBy) : null, i.key, i.sourceMessageId ?? null, now()],
  );
  if (row) return { item: row, created: true };
  return { item: (await one<FundItemRow>(`SELECT * FROM fund_items WHERE idempotency_key = $1`, [i.key]))!, created: false };
}

/** Take the stay off the fund (a new place or new dates) unless the fund already paid it. */
export async function removeUnpaidStay(tripId: number): Promise<number> {
  const rows = await q(`UPDATE fund_items SET status = 'removed' WHERE trip_id = $1 AND kind = 'stay' AND status = 'active' AND paid_at IS NULL RETURNING id`, [tripId]);
  return rows.length;
}

// ---------- contributions ----------

export interface PersonContributions {
  personId: number;
  shareCents: number;
  contributedCents: number;
  /** Scheduled installments still to go in. */
  plan: { dueDate: string; amountCents: number }[];
  /** False: no paycheck rhythm known, so every two weeks. */
  onPaydays: boolean;
  /** Connected bank behind the transfers (false: tracked in the ledger only). */
  bank: boolean;
  unchanged: boolean;
}

/** Plans are keyed by what they're for: the same share and deadline keep the same rows. */
export function contributionPlanKey(shareCents: number, deadline: string): string {
  return createHash("sha1").update(`${shareCents}|${deadline}`).digest("hex").slice(0, 8);
}

async function personBank(personId: number, client: NessieClient | null) {
  const link = await linkFor(personId);
  const bank = Boolean(client && link?.checking_id && link.seed_status === "ready" && !link.seed_progress.offline);
  return { link, bank };
}

async function upcomingPaydays(personId: number, client: NessieClient | null, from: string, until: string): Promise<string[]> {
  const link = await linkFor(personId);
  if (link?.seed_status !== "ready") return [];
  try {
    const ledger = await readLedger(link, client);
    const pay = ledger.txns.filter((t) => t.kind === "deposit" && PAYCHECK_PATTERN.test(t.description)).map((t) => t.date);
    return inferPaycheckCadence(pay).nextPaydays(from, until);
  } catch {
    return [];
  }
}

/**
 * Plan everyone's contributions for the fund's current target: each person's share
 * (fundShares by split mode) less what they've already put in, in installments on the day after
 * each payday before the deadline. Rows under an unchanged plan are kept; everything else
 * scheduled is cancelled. People no longer in the group stop being scheduled.
 */
export async function planContributions(trip: TripRow, memberIds: number[], today: string, client: NessieClient | null = sharedNessie()): Promise<{ people: PersonContributions[]; deadline: string; dueDates: string[] }> {
  const items = await fundItems(trip.id);
  const start = trip.start_date ?? addDays(today, 30);
  const deadline = depositDeadline(start, today);
  await ensureFundRow(trip.id, deadline);
  await q(`UPDATE trip_funds SET deadline = $2 WHERE trip_id = $1`, [trip.id, deadline]);
  const shares = fundShares(
    items.map((i) => ({ amountCents: i.amount_cents, sharedBy: i.shared_by })),
    memberIds,
    trip.split_mode ?? "by_cost",
  );
  const paid = await doneBy(trip.id, "contribution");
  const people: PersonContributions[] = [];
  for (const personId of memberIds) {
    const shareCents = shares.get(personId) ?? 0;
    const contributedCents = paid.get(personId) ?? 0;
    const key = contributionPlanKey(shareCents, deadline);
    const { bank } = await personBank(personId, client);
    const existing = await q<{ due_date: string; amount_cents: number }>(
      `SELECT due_date, amount_cents FROM fund_txns WHERE trip_id = $1 AND person_id = $2 AND kind = 'contribution' AND status = 'scheduled' AND plan_key = $3 ORDER BY due_date`,
      [trip.id, personId, key],
    );
    await q(`UPDATE fund_txns SET status = 'cancelled' WHERE trip_id = $1 AND person_id = $2 AND kind = 'contribution' AND status = 'scheduled' AND plan_key IS DISTINCT FROM $3`, [trip.id, personId, key]);
    if (existing.length) {
      people.push({ personId, shareCents, contributedCents, plan: existing.map((e) => ({ dueDate: e.due_date, amountCents: e.amount_cents })), onPaydays: true, bank, unchanged: true });
      continue;
    }
    const remaining = Math.max(0, shareCents - contributedCents);
    const paydays = remaining > 0 ? await upcomingPaydays(personId, client, addDays(today, 1), deadline) : [];
    const plan = planInstallments({ shareCents: remaining, today, deadline, paydays });
    for (const [i, inst] of plan.entries()) {
      await q(
        `INSERT INTO fund_txns (trip_id, person_id, kind, amount_cents, due_date, plan_key, idempotency_key, created_at) VALUES ($1,$2,'contribution',$3,$4,$5,$6,$7)
         ON CONFLICT (idempotency_key) DO UPDATE SET status = 'scheduled', due_date = EXCLUDED.due_date, amount_cents = EXCLUDED.amount_cents WHERE fund_txns.status <> 'done'`,
        [trip.id, personId, inst.amountCents, inst.dueDate, key, `fundc:${trip.id}:${key}:${personId}:${contributedCents}:${i}`, now()],
      );
    }
    people.push({ personId, shareCents, contributedCents, plan, onPaydays: paydays.length > 0, bank, unchanged: false });
  }
  await q(`UPDATE fund_txns SET status = 'cancelled' WHERE trip_id = $1 AND kind = 'contribution' AND status = 'scheduled' AND NOT (person_id = ANY($2::bigint[]))`, [trip.id, memberIds]);
  const dueDates = [...new Set(people.flatMap((p) => p.plan.map((i) => i.dueDate)))].sort();
  return { people, deadline, dueDates };
}

/** Each person's committed share: scheduled plus done contributions (the people on the fund). */
export async function contributionTotals(tripId: number): Promise<Map<number, number>> {
  const rows = await q<{ person_id: number; total: number }>(
    `SELECT person_id, sum(amount_cents)::bigint AS total FROM fund_txns WHERE trip_id = $1 AND kind = 'contribution' AND status IN ('scheduled','done') AND person_id IS NOT NULL GROUP BY person_id`,
    [tripId],
  );
  return new Map(rows.map((r) => [Number(r.person_id), Number(r.total)]));
}

/** What each person is committed to spend on the trip: their fund share plus their own travel. */
export async function committedTotals(tripId: number): Promise<Map<number, number>> {
  const fund = await contributionTotals(tripId);
  if (fund.size === 0) return fund;
  const travel = await q<{ person_id: number; est_cost_cents: number | null }>(`SELECT person_id, est_cost_cents FROM travel_plans WHERE trip_id = $1`, [tripId]);
  const out = new Map(fund);
  for (const t of travel) if (out.has(Number(t.person_id)) && t.est_cost_cents) out.set(Number(t.person_id), out.get(Number(t.person_id))! + Number(t.est_cost_cents));
  return out;
}

// ---------- moving money ----------

/**
 * Account → account in Nessie: a transfer naming the payee when this Nessie supports it, else a
 * plain transfer out plus a matching deposit on the receiving side.
 */
export async function bankTransfer(
  client: NessieClient,
  from: { accountId: string; personId?: number },
  to: { accountId: string; personId?: number },
  cents: number,
  description: string,
  done: { transferId?: string | null; depositId?: string | null } = {},
): Promise<{ transferId: string; depositId: string | null }> {
  const at = now().toISOString().slice(0, 10);
  const amount = nessieAmount(cents);
  let transferId = done.transferId ?? null;
  let depositId = done.depositId ?? null;
  if (!transferId) {
    transferId = capabilities().transferWithPayee
      ? (await client.createOn(from.accountId, "transfers", { medium: "balance", payee_id: to.accountId, amount, transaction_date: at, status: "completed", description }, from.personId)).id
      : (await client.createOn(from.accountId, "transfers", { transaction_date: at, status: "completed", amount, description }, from.personId)).id;
  }
  if (!capabilities().transferWithPayee && !depositId) {
    depositId = (await client.createOn(to.accountId, "deposits", { medium: "balance", transaction_date: at, status: "completed", amount, description }, to.personId)).id;
  }
  return { transferId, depositId };
}

/**
 * Move one scheduled contribution: the person's checking → the fund account when both exist,
 * else recorded in the ledger. Idempotent (a done row is returned as is). Throws when the bank
 * call fails (the row is marked failed with the error; callers retry).
 */
export async function executeContribution(txn: FundTxnRow, trip: TripRow, client: NessieClient | null = sharedNessie()): Promise<FundTxnRow> {
  if (txn.status === "done") return txn;
  const fundAccount = await ensureFundAccount(trip, client);
  const { link, bank } = await personBank(txn.person_id!, client);
  const finish = async (via: "bank" | "ledger", ids: { transferId?: string | null; depositId?: string | null } = {}) =>
    (await one<FundTxnRow>(
      `UPDATE fund_txns SET status = 'done', via = $2, nessie_transfer_id = COALESCE($3, nessie_transfer_id), nessie_deposit_id = COALESCE($4, nessie_deposit_id), executed_at = $5, last_error = NULL WHERE id = $1 RETURNING *`,
      [txn.id, via, ids.transferId ?? null, ids.depositId ?? null, now()],
    ))!;
  if (!client || !fundAccount || !bank || !link?.checking_id) return finish("ledger");
  try {
    const ids = await bankTransfer(client, { accountId: link.checking_id, personId: txn.person_id! }, { accountId: fundAccount }, txn.amount_cents, `[atlas] ${fundName(trip)} contribution (${txn.idempotency_key})`, {
      transferId: txn.nessie_transfer_id,
      depositId: txn.nessie_deposit_id,
    });
    return finish("bank", ids);
  } catch (err) {
    await q(`UPDATE fund_txns SET status = 'failed', last_error = $2 WHERE id = $1`, [txn.id, (err as Error).message.slice(0, 300)]);
    throw err;
  }
}

/** Record (and move) a contribution that isn't from the schedule, e.g. a settle-up payment into the fund. */
export async function recordContribution(trip: TripRow, personId: number, cents: number, key: string, client: NessieClient | null = sharedNessie()): Promise<FundTxnRow> {
  const row =
    (await one<FundTxnRow>(
      `INSERT INTO fund_txns (trip_id, person_id, kind, amount_cents, due_date, idempotency_key, created_at) VALUES ($1,$2,'contribution',$3,$4,$5,$6)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [trip.id, personId, cents, now().toISOString().slice(0, 10), key, now()],
    )) ?? (await one<FundTxnRow>(`SELECT * FROM fund_txns WHERE idempotency_key = $1`, [key]))!;
  if (row.status === "failed") await q(`UPDATE fund_txns SET status = 'scheduled' WHERE id = $1`, [row.id]);
  return executeContribution({ ...row, status: row.status === "failed" ? "scheduled" : row.status }, trip, client);
}

/** Fund → a person's checking (the leftover at settle-up). Ledger only when either side has no bank. */
export async function refundFromFund(trip: TripRow, personId: number, cents: number, key: string, client: NessieClient | null = sharedNessie()): Promise<FundTxnRow> {
  const row =
    (await one<FundTxnRow>(
      `INSERT INTO fund_txns (trip_id, person_id, kind, amount_cents, idempotency_key, created_at) VALUES ($1,$2,'refund',$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [trip.id, personId, cents, key, now()],
    )) ?? (await one<FundTxnRow>(`SELECT * FROM fund_txns WHERE idempotency_key = $1`, [key]))!;
  if (row.status === "done") return row;
  const fund = await getFund(trip.id);
  const { link, bank } = await personBank(personId, client);
  let via: "bank" | "ledger" = "ledger";
  let ids: { transferId: string | null; depositId: string | null } = { transferId: null, depositId: null };
  if (client && fund?.nessie_account_id && bank && link?.checking_id) {
    try {
      ids = await bankTransfer(client, { accountId: fund.nessie_account_id }, { accountId: link.checking_id, personId }, cents, `[atlas] ${fundName(trip)} refund (${key})`, {
        transferId: row.nessie_transfer_id,
        depositId: row.nessie_deposit_id,
      });
      via = "bank";
    } catch (err) {
      // The leftover is theirs either way; the ledger keeps it if the bank is down.
      log().warn({ err: (err as Error).message, tripId: trip.id }, "fund refund transfer failed; recorded in the ledger");
    }
  }
  return (await one<FundTxnRow>(
    `UPDATE fund_txns SET status = 'done', via = $2, nessie_transfer_id = $3, nessie_deposit_id = $4, executed_at = $5 WHERE id = $1 RETURNING *`,
    [row.id, via, ids.transferId, ids.depositId, now()],
  ))!;
}

async function merchantFor(client: NessieClient, name: string, category: string): Promise<string> {
  const row = await one<{ merchant_id: string }>(`SELECT merchant_id FROM nessie_merchants WHERE name = $1`, [name]);
  if (row) return row.merchant_id;
  const made = await client.createMerchant({ name, category: capabilities().merchantCategory === "array" ? [category] : category });
  await q(`INSERT INTO nessie_merchants (name, category, merchant_id, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING`, [name, category, made.id, now()]);
  return made.id;
}

/**
 * Pay whatever the fund can now cover, the stay first: a Nessie purchase from the fund account
 * at a merchant named after it (ledger only offline). Returns the items paid.
 */
export async function payDueItems(trip: TripRow, client: NessieClient | null = sharedNessie()): Promise<FundItemRow[]> {
  const items = (await fundItems(trip.id)).filter((i) => !i.paid_at);
  if (!items.length) return [];
  let { balanceCents } = await fundTotals(trip.id);
  const paid: FundItemRow[] = [];
  const fund = await getFund(trip.id);
  for (const item of items) {
    if (item.amount_cents > balanceCents) break;
    let via: "bank" | "ledger" = "ledger";
    let purchaseId: string | null = null;
    let merchantId: string | null = item.nessie_merchant_id;
    if (client && fund?.nessie_account_id) {
      try {
        merchantId ??= await merchantFor(client, item.description, item.kind === "stay" ? "lodging" : "travel");
        purchaseId = (
          await client.createOn(fund.nessie_account_id, "purchases", {
            merchant_id: merchantId,
            medium: "balance",
            purchase_date: now().toISOString().slice(0, 10),
            amount: nessieAmount(item.amount_cents),
            status: "completed",
            description: `[atlas] ${item.description} (${fundName(trip)})`,
          })
        ).id;
        via = "bank";
      } catch (err) {
        log().warn({ err: (err as Error).message, itemId: item.id }, "fund purchase failed; will retry when the fund is checked again");
        break;
      }
    }
    await q(
      `INSERT INTO fund_txns (trip_id, kind, amount_cents, status, via, item_id, nessie_transfer_id, idempotency_key, executed_at, created_at) VALUES ($1,'purchase',$2,'done',$3,$4,$5,$6,$7,$7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [trip.id, item.amount_cents, via, item.id, purchaseId, `fundp:${item.id}`, now()],
    );
    const updated = await one<FundItemRow>(`UPDATE fund_items SET paid_at = $2, nessie_purchase_id = $3, nessie_merchant_id = $4 WHERE id = $1 RETURNING *`, [item.id, now(), purchaseId, merchantId]);
    paid.push(updated!);
    balanceCents -= item.amount_cents;
  }
  return paid;
}

/** Contributions scheduled on or before `day`, oldest first. */
export async function dueContributions(tripId: number, day: string): Promise<FundTxnRow[]> {
  return q<FundTxnRow>(`SELECT * FROM fund_txns WHERE trip_id = $1 AND kind = 'contribution' AND status IN ('scheduled','failed') AND due_date <= $2 ORDER BY due_date, id`, [tripId, day]);
}

/** Each person's next scheduled contribution. */
export async function nextContributions(tripId: number): Promise<Map<number, { dueDate: string; amountCents: number }>> {
  const rows = await q<{ person_id: number; due_date: string; amount_cents: number }>(
    `SELECT DISTINCT ON (person_id) person_id, due_date, amount_cents FROM fund_txns WHERE trip_id = $1 AND kind = 'contribution' AND status = 'scheduled' ORDER BY person_id, due_date, id`,
    [tripId],
  );
  return new Map(rows.map((r) => [Number(r.person_id), { dueDate: r.due_date, amountCents: Number(r.amount_cents) }]));
}
