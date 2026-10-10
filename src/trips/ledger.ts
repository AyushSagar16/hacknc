// Trip money in Postgres: expenses (exact cents, idempotent by source message), the append-only
// spend_events hypertable behind the trip_spend_daily continuous aggregate, settlements and
// installments. Nessie objects are the system of record for money movement; these rows link to them.
import { randomUUID } from "node:crypto";
import { now } from "../clock.ts";
import { one, q, type Queryable, db } from "../db/pool.ts";
import { balances, planTransfers, type Payment } from "../money/settle.ts";

export interface ExpenseRow {
  id: number;
  trip_id: number;
  payer_id: number;
  amount_cents: number;
  description: string;
  category: string;
  shares: Record<string, number>;
  items: unknown[];
  nessie_purchase_id: string | null;
  source_message_id: number | null;
  idempotency_key: string;
  status: "active" | "voided";
  replaces_id: number | null;
  spent_on: string;
  created_at: Date;
}

export interface SettlementRow {
  id: number;
  trip_id: number;
  from_id: number;
  to_id: number;
  amount_cents: number;
  status: "proposed" | "confirmed" | "executing" | "executed" | "failed" | "cancelled";
  plan_id: string;
  nessie_transfer_id: string | null;
  nessie_deposit_id: string | null;
  idempotency_key: string;
  last_error: string | null;
}

const CATEGORIES: [RegExp, string][] = [
  [/\b(dinner|lunch|breakfast|brunch|food|tacos?|pizza|drinks?|bar|coffee|groceries|snacks?|restaurant|meal)\b/i, "food"],
  [/\b(uber|lyft|taxi|gas|parking|train|bus|ferry|flight|car|rental|tolls?)\b/i, "transport"],
  [/\b(airbnb|hotel|hostel|lodging|stay|room|cabin|deposit)\b/i, "lodging"],
  [/\b(tickets?|tour|museum|kayak|boat|show|class|entry|admission|activity)\b/i, "activities"],
];

export function categorize(description: string): string {
  return CATEGORIES.find(([re]) => re.test(description))?.[1] ?? "other";
}

export async function expenseByKey(key: string): Promise<ExpenseRow | undefined> {
  return one<ExpenseRow>(`SELECT * FROM expenses WHERE idempotency_key = $1`, [key]);
}

export async function insertExpense(
  e: Omit<ExpenseRow, "id" | "created_at" | "status" | "replaces_id" | "nessie_purchase_id"> & { replaces_id?: number | null; nessie_purchase_id?: string | null },
  on: Queryable = db(),
): Promise<ExpenseRow> {
  const at = now();
  const row = await one<ExpenseRow>(
    `INSERT INTO expenses (trip_id, payer_id, amount_cents, description, category, shares, items, nessie_purchase_id, source_message_id, idempotency_key, replaces_id, spent_on, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [e.trip_id, e.payer_id, e.amount_cents, e.description, e.category, JSON.stringify(e.shares), JSON.stringify(e.items), e.nessie_purchase_id ?? null, e.source_message_id, e.idempotency_key, e.replaces_id ?? null, e.spent_on, at],
    on,
  );
  if (!row) return (await expenseByKey(e.idempotency_key))!;
  await q(`INSERT INTO spend_events (at, trip_id, expense_id, category, amount_cents) VALUES ($1,$2,$3,$4,$5)`, [at, row.trip_id, row.id, row.category, row.amount_cents], on);
  return row;
}

export async function setExpenseNessie(id: number, purchaseId: string): Promise<void> {
  await q(`UPDATE expenses SET nessie_purchase_id = $2 WHERE id = $1`, [id, purchaseId]);
}

export async function voidExpense(id: number): Promise<ExpenseRow | undefined> {
  const row = await one<ExpenseRow>(`UPDATE expenses SET status = 'voided' WHERE id = $1 AND status = 'active' RETURNING *`, [id]);
  if (row) await q(`INSERT INTO spend_events (at, trip_id, expense_id, category, amount_cents) VALUES ($1,$2,$3,$4,$5)`, [now(), row.trip_id, row.id, row.category, -row.amount_cents]);
  return row;
}

export async function activeExpenses(tripId: number): Promise<ExpenseRow[]> {
  return q<ExpenseRow>(`SELECT * FROM expenses WHERE trip_id = $1 AND status = 'active' ORDER BY id`, [tripId]);
}

export async function expenseNumber(tripId: number, n: number): Promise<ExpenseRow | undefined> {
  // "#3" in chat is the 3rd expense ever logged on this trip (voided ones keep their number).
  return one<ExpenseRow>(`SELECT * FROM expenses WHERE trip_id = $1 ORDER BY id OFFSET $2 LIMIT 1`, [tripId, n - 1]);
}

export async function numberOf(expense: ExpenseRow): Promise<number> {
  const row = await one<{ n: number }>(`SELECT count(*)::int AS n FROM expenses WHERE trip_id = $1 AND id <= $2`, [expense.trip_id, expense.id]);
  return row?.n ?? 0;
}

export async function executedSettlements(tripId: number): Promise<SettlementRow[]> {
  return q<SettlementRow>(`SELECT * FROM settlements WHERE trip_id = $1 AND status = 'executed' ORDER BY id`, [tripId]);
}

export async function tripBalances(tripId: number, memberIds: number[]): Promise<{ net: Map<number, number>; plan: Payment<number>[]; totalCents: number; count: number }> {
  const expenses = await activeExpenses(tripId);
  const settled = await executedSettlements(tripId);
  const members = [...new Set([...memberIds, ...expenses.map((e) => e.payer_id), ...expenses.flatMap((e) => Object.keys(e.shares).map(Number))])];
  const net = balances(
    members,
    expenses.map((e) => ({ payer: e.payer_id, shares: new Map(Object.entries(e.shares).map(([k, v]) => [Number(k), v])) })),
    settled.map((s) => ({ from: s.from_id, to: s.to_id, amountCents: s.amount_cents })),
  );
  return { net, plan: planTransfers(members, net), totalCents: expenses.reduce((a, e) => a + e.amount_cents, 0), count: expenses.length };
}

/** Replace any proposed plan with a fresh one. */
export async function proposeSettlements(tripId: number, plan: Payment<number>[]): Promise<SettlementRow[]> {
  await q(`UPDATE settlements SET status = 'cancelled' WHERE trip_id = $1 AND status IN ('proposed')`, [tripId]);
  const planId = randomUUID().slice(0, 8);
  const rows: SettlementRow[] = [];
  for (const [i, p] of plan.entries()) {
    const row = await one<SettlementRow>(
      `INSERT INTO settlements (trip_id, from_id, to_id, amount_cents, plan_id, idempotency_key, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tripId, p.from, p.to, p.amountCents, planId, `settle:${planId}:${i}`, now()],
    );
    rows.push(row!);
  }
  return rows;
}

export async function openSettlements(tripId: number): Promise<SettlementRow[]> {
  return q<SettlementRow>(`SELECT * FROM settlements WHERE trip_id = $1 AND status IN ('proposed','confirmed','executing','failed') ORDER BY id`, [tripId]);
}

export async function spentSoFar(tripId: number): Promise<{ totalCents: number; byCategory: Record<string, number> }> {
  // Served by the trip_spend_daily continuous aggregate (real-time: includes just-logged expenses).
  const rows = await q<{ category: string; spent: number }>(`SELECT category, sum(spent_cents)::bigint AS spent FROM trip_spend_daily WHERE trip_id = $1 GROUP BY category`, [tripId]);
  const byCategory = Object.fromEntries(rows.map((r) => [r.category, Number(r.spent)]));
  return { totalCents: Object.values(byCategory).reduce((a, b) => a + b, 0), byCategory };
}
