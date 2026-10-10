// Budgets per person per trip: computed from Nessie accounts by the budget engine, adjustable by
// text, public by default or private (pooled-only). Every stored row keeps the formula inputs,
// the data source (live Nessie, cached Nessie, or the offline demo profile) and the Nessie ids.
import { now } from "../clock.ts";
import { one, q } from "../db/pool.ts";
import { computeBudget, poolBudgets, type BudgetResult, type PoolSummary } from "../money/budget.ts";
import { readLedger } from "./ledger.ts";
import { linkFor, sharedNessie } from "./seed.ts";

export interface BudgetInputs {
  result?: BudgetResult;
  source?: "nessie" | "nessie-cache" | "offline-profile";
  fetchedAt?: string | null;
  tripStart?: string | null;
  persona?: string;
  customerId?: string | null;
  accountIds?: string[];
}

export interface BudgetRow {
  person_id: number;
  trip_id: number;
  suggested_cents: number | null;
  adjusted_cents: number | null;
  inputs: BudgetInputs;
  visibility: "public" | "private";
  announced_at: Date | null;
  updated_at: Date;
}

export const effectiveCents = (r: Pick<BudgetRow, "suggested_cents" | "adjusted_cents">): number | null => r.adjusted_cents ?? r.suggested_cents;

export async function budgetRows(tripId: number): Promise<BudgetRow[]> {
  return q<BudgetRow>(`SELECT * FROM budgets WHERE trip_id = $1`, [tripId]);
}

async function upsert(personId: number, tripId: number, patch: Partial<Pick<BudgetRow, "suggested_cents" | "adjusted_cents" | "inputs" | "visibility" | "announced_at">>): Promise<BudgetRow> {
  const existing = await one<BudgetRow>(`SELECT * FROM budgets WHERE person_id = $1 AND trip_id = $2`, [personId, tripId]);
  const next = { suggested_cents: null, adjusted_cents: null, inputs: {}, visibility: "public" as const, announced_at: null, ...existing, ...patch };
  const row = await one<BudgetRow>(
    `INSERT INTO budgets (person_id, trip_id, suggested_cents, adjusted_cents, inputs, visibility, announced_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (person_id, trip_id) DO UPDATE SET suggested_cents = $3, adjusted_cents = $4, inputs = $5, visibility = $6, announced_at = $7, updated_at = $8
     RETURNING *`,
    [personId, tripId, next.suggested_cents, next.adjusted_cents, JSON.stringify(next.inputs), next.visibility, next.announced_at, now()],
  );
  return row!;
}

/** Recompute one person's budget from their (demo) accounts. Null if their profile isn't ready. */
export async function refreshBudget(personId: number, tripId: number, today: string, tripStart: string | null): Promise<BudgetRow | null> {
  const link = await linkFor(personId);
  if (!link || link.seed_status !== "ready") return null;
  const ledger = await readLedger(link, sharedNessie());
  const result = computeBudget({ asOf: today, tripStart, accounts: ledger.accounts, txns: ledger.txns, bills: ledger.bills });
  return upsert(personId, tripId, {
    suggested_cents: result.budgetCents,
    inputs: {
      result,
      source: ledger.source,
      fetchedAt: ledger.fetchedAt?.toISOString() ?? null,
      tripStart,
      persona: link.persona,
      customerId: link.customer_id,
      accountIds: ledger.accountIds,
    },
  });
}

/** Budgets for everyone in the chat, recomputed when stale (6 h) or when the trip start changed. */
export async function ensureBudgets(tripId: number, memberIds: number[], today: string, tripStart: string | null): Promise<{ rows: BudgetRow[]; pending: number[] }> {
  const rows = new Map((await budgetRows(tripId)).map((r) => [r.person_id, r]));
  const pending: number[] = [];
  for (const id of memberIds) {
    const row = rows.get(id);
    const stale = !row || row.suggested_cents === null || (row.inputs.tripStart ?? null) !== tripStart || now().getTime() - row.updated_at.getTime() > 6 * 3_600_000;
    if (!stale) continue;
    const fresh = await refreshBudget(id, tripId, today, tripStart);
    if (fresh) rows.set(id, fresh);
    else if (!row || row.suggested_cents === null) pending.push(id);
  }
  return { rows: memberIds.map((id) => rows.get(id)).filter((r): r is BudgetRow => Boolean(r && effectiveCents(r) !== null)), pending };
}

export async function setVisibility(personId: number, tripId: number, visibility: "public" | "private"): Promise<void> {
  await upsert(personId, tripId, { visibility });
  // Their budget comments follow the setting, so memory and the agent's view never leak them.
  await q(`UPDATE facts SET visibility = $2 WHERE person_id = $1 AND key = 'budget_comment'`, [personId, visibility]);
  await q(`UPDATE memory_chunks SET visibility = $2 WHERE person_id = $1 AND meta->>'key' = 'budget_comment'`, [personId, visibility]);
}

export async function setAdjusted(personId: number, tripId: number, cents: number | null): Promise<BudgetRow> {
  return upsert(personId, tripId, { adjusted_cents: cents });
}

export async function markAnnounced(tripId: number, personIds: number[]): Promise<void> {
  await q(`UPDATE budgets SET announced_at = $3 WHERE trip_id = $1 AND person_id = ANY($2) AND announced_at IS NULL`, [tripId, personIds, now()]);
}

export function pool(rows: BudgetRow[]): PoolSummary {
  return poolBudgets(rows.map((r) => ({ personId: r.person_id, budgetCents: effectiveCents(r)!, visibility: r.visibility })));
}
