// The trip fund and the booked stay as the trip page shows them: first names only, what each
// person put in and owes the fund (never a budget), and the fund's transactions newest first.
import { q } from "../db/pool.ts";
import { labelOf } from "../db/repos/core.ts";
import { contributionTotals, doneBy, fundItems, fundName, fundTotals, getFund, nextContributions } from "../trips/fund.ts";
import type { TripRow } from "../trips/state.ts";
import type { SiteFund, SiteStay } from "./types.ts";

const firstOf = (label: string) => {
  const first = label.trim().split(/\s+/)[0] ?? "";
  return first.startsWith("…") ? "Someone" : first.charAt(0).toUpperCase() + first.slice(1);
};

export async function siteFund(trip: TripRow): Promise<SiteFund | undefined> {
  const fund = await getFund(trip.id);
  const items = await fundItems(trip.id);
  if (!fund || items.length === 0) return undefined;
  const totals = await fundTotals(trip.id);
  const shares = await contributionTotals(trip.id);
  const paid = await doneBy(trip.id, "contribution");
  const next = await nextContributions(trip.id);
  const ids = [...new Set([...shares.keys(), ...paid.keys()])];
  const people = await q<{ id: number; display_name: string | null; handle: string | null }>(`SELECT id, display_name, handle FROM people WHERE id = ANY($1::bigint[])`, [ids]);
  const name = new Map(people.map((p) => [Number(p.id), firstOf(labelOf(p))]));
  const txns = await q<{ person_id: number | null; kind: "contribution" | "refund" | "purchase"; amount_cents: number; executed_at: Date; item: string | null }>(
    `SELECT t.person_id, t.kind, t.amount_cents, t.executed_at, i.description AS item
       FROM fund_txns t LEFT JOIN fund_items i ON i.id = t.item_id
      WHERE t.trip_id = $1 AND t.status = 'done' ORDER BY t.executed_at DESC, t.id DESC LIMIT 50`,
    [trip.id],
  );
  return {
    accountLabel: `Capital One · ${fundName(trip)}`,
    targetCents: totals.targetCents,
    collectedCents: totals.collectedCents,
    deadline: fund.deadline,
    members: ids.map((id) => ({
      name: name.get(id) ?? "Someone",
      shareCents: shares.get(id) ?? 0,
      contributedCents: paid.get(id) ?? 0,
      nextCents: next.get(id)?.amountCents ?? null,
      nextDate: next.get(id)?.dueDate ?? null,
    })),
    transactions: txns.map((t) => ({
      at: new Date(t.executed_at).toISOString(),
      kind: t.kind,
      label:
        t.kind === "purchase"
          ? (t.item ?? "Purchase")
          : t.kind === "refund"
            ? `Refund to ${name.get(Number(t.person_id)) ?? "someone"}`
            : `${name.get(Number(t.person_id)) ?? "Someone"}'s contribution`,
      amountCents: Number(t.amount_cents),
    })),
  };
}

export function siteStay(trip: TripRow): SiteStay | undefined {
  const s = trip.stay;
  if (!s?.name || !s.check_in || !s.check_out) return undefined;
  return { name: s.name, kind: s.kind, checkIn: s.check_in, checkOut: s.check_out, totalCents: s.total_cents ?? 0, link: s.link ?? null, rating: s.rating ?? null };
}
