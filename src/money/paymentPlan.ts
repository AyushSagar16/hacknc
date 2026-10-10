// Paycheck-aligned installment plans: infer how often someone gets paid from their past
// paydays, then schedule their trip share for the day after each upcoming payday.
import { addDays, daysBetween } from "../clock.ts";

type Cents = number;

export type CadenceKind = "weekly" | "biweekly" | "semimonthly" | "monthly" | "irregular";

export interface PaycheckCadence {
  kind: CadenceKind;
  lastPayday: string | null;
  /** Known or projected paydays with from <= day <= until, ascending. */
  nextPaydays(from: string, until: string): string[];
}

export interface Installment {
  dueDate: string;
  amountCents: Cents;
}

export interface InstallmentInput {
  shareCents: Cents;
  today: string;
  /** The full share is due by this day (inclusive). */
  deadline: string;
  /** Upcoming paydays, e.g. from `inferPaycheckCadence(...).nextPaydays(today, deadline)`. */
  paydays: string[];
  maxInstallments?: number;
  minInstallmentCents?: Cents;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const IRREGULAR_GUESS_DAYS = 14;

export function inferPaycheckCadence(paydays: string[]): PaycheckCadence {
  const days = [...new Set(paydays.filter((d) => ISO_DAY.test(d)))].sort();
  const last = days.at(-1) ?? null;
  const fixedStep = (kind: CadenceKind, step: number): PaycheckCadence => ({
    kind,
    lastPayday: last,
    nextPaydays: (from, until) => (last ? project(last, from, until, (i) => addDays(last, step * i)) : []),
  });
  if (!last || days.length < 2) return fixedStep("irregular", IRREGULAR_GUESS_DAYS);

  const gaps = days.slice(1).map((d, i) => daysBetween(days[i]!, d));
  const gap = median(gaps);

  // Checked first: 1st/15th pay has ~14-17 day gaps that would otherwise read as biweekly.
  if (gap >= 12 && gap <= 18) {
    const centers = semimonthlyCenters(days, gaps);
    if (centers) return calendarCadence("semimonthly", last, centers);
  }
  if (gap >= 6 && gap <= 8 && consistent(gaps, 7, 1)) return fixedStep("weekly", 7);
  if (gap >= 13 && gap <= 15 && consistent(gaps, 14, 2)) return fixedStep("biweekly", 14);
  if (gap >= 28 && gap <= 31 && consistent(gaps, 30.44, 3)) return calendarCadence("monthly", last, [modeDayOfMonth(days)]);
  return fixedStep("irregular", IRREGULAR_GUESS_DAYS);
}

export function planInstallments(input: InstallmentInput): Installment[] {
  const share = Math.round(input.shareCents);
  if (share <= 0) return [];
  const maxCount = Math.max(1, Math.floor(input.maxInstallments ?? 4));
  const minAmount = Math.max(1, Math.round(input.minInstallmentCents ?? 2500));
  const { today, deadline } = input;

  // Earliest slots first so money is collected early; every slot is already <= deadline.
  const slots = [...new Set(input.paydays.filter((d) => ISO_DAY.test(d)).map((d) => addDays(d, 1)))]
    .filter((due) => due > today && due <= deadline)
    .sort()
    .slice(0, maxCount);
  if (slots.length === 0) {
    const tomorrow = addDays(today, 1);
    return [{ dueDate: tomorrow < deadline ? tomorrow : deadline, amountCents: share }];
  }

  // Fewer, larger installments instead of any below the minimum (a lone small share stays whole).
  const count = Math.max(1, Math.min(slots.length, Math.floor(share / minAmount)));
  const base = Math.floor(share / count);
  const remainder = share - base * count;
  return slots.slice(0, count).map((dueDate, i) => ({ dueDate, amountCents: base + (i === 0 ? remainder : 0) }));
}

// Semimonthly = paydays cluster within 2 days of two days-of-month 12-18 apart (weekend
// shifts allowed), each cluster has at least two paydays, and the gaps are not a strict
// 14-day rhythm (which is biweekly that happens to line up for a month or two).
function semimonthlyCenters(days: string[], gaps: number[]): number[] | null {
  if (days.length < 5) return null;
  if (gaps.filter((g) => g === 14).length / gaps.length >= 0.9) return null;
  const doms = [...new Set(days.map(dayOfMonth))].sort((a, b) => a - b);
  let best: { centers: number[]; near: number; exact: number } | null = null;
  for (const a of doms) {
    for (const b of doms) {
      if (b - a < 12 || b - a > 18) continue;
      let near = 0;
      let exact = 0;
      let ownA = 0;
      let ownB = 0;
      for (const d of days) {
        const da = distanceToDom(d, a);
        const db = distanceToDom(d, b);
        const nearest = Math.min(da, db);
        if (nearest > 2) continue;
        near++;
        if (nearest === 0) exact++;
        if (da <= db) ownA++;
        else ownB++;
      }
      if (near / days.length < 0.8 || ownA < 2 || ownB < 2) continue;
      if (!best || near > best.near || (near === best.near && exact > best.exact)) best = { centers: [a, b], near, exact };
    }
  }
  return best?.centers ?? null;
}

// Paydays on fixed days of the month (clamped to month length, moved back to Friday when
// they land on a weekend). Projections within 3 days of the last payday are the same
// period paid early, so they are skipped.
function calendarCadence(kind: CadenceKind, last: string, doms: number[]): PaycheckCadence {
  return {
    kind,
    lastPayday: last,
    nextPaydays(from, until) {
      if (from > until) return [];
      const out = from <= last && last <= until ? [last] : [];
      const notBefore = addDays(last, 3);
      // One month past `until`: a weekend shift can pull next month's 1st into this month.
      const end = shiftMonth(until.slice(0, 7), 1);
      for (let ym = last.slice(0, 7); ym <= end; ym = shiftMonth(ym, 1)) {
        for (const dom of doms) {
          const d = previousBusinessDay(`${ym}-${String(Math.min(dom, daysInMonth(ym))).padStart(2, "0")}`);
          if (d > notBefore && d >= from && d <= until) out.push(d);
        }
      }
      return [...new Set(out)].sort();
    },
  };
}

function project(last: string, from: string, until: string, nth: (i: number) => string): string[] {
  if (from > until) return [];
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const d = nth(i);
    if (d > until) break;
    if (d >= from) out.push(d);
  }
  return out;
}

function consistent(gaps: number[], step: number, tolerance: number): boolean {
  // A missed payday shows up as a double gap; that still fits the rhythm.
  const fits = gaps.filter((g) => Math.abs(g - step) <= tolerance || Math.abs(g - 2 * step) <= tolerance);
  return fits.length / gaps.length >= 0.6;
}

function distanceToDom(date: string, dom: number): number {
  const ym = date.slice(0, 7);
  let best = Infinity;
  for (const m of [shiftMonth(ym, -1), ym, shiftMonth(ym, 1)]) {
    const candidate = `${m}-${String(Math.min(dom, daysInMonth(m))).padStart(2, "0")}`;
    best = Math.min(best, Math.abs(daysBetween(date, candidate)));
  }
  return best;
}

function modeDayOfMonth(days: string[]): number {
  const tally = new Map<number, number>();
  for (const d of days) tally.set(dayOfMonth(d), (tally.get(dayOfMonth(d)) ?? 0) + 1);
  let best = dayOfMonth(days.at(-1)!);
  for (const [dom, n] of tally) if (n > (tally.get(best) ?? 0)) best = dom;
  return best;
}

function previousBusinessDay(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 6 ? addDays(day, -1) : dow === 0 ? addDays(day, -2) : day;
}

function dayOfMonth(day: string): number {
  return Number(day.slice(8, 10));
}

function daysInMonth(ym: string): number {
  return new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
}

function shiftMonth(ym: string, delta: number): string {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
