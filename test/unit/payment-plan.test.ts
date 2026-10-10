// Paycheck cadence inference and paycheck-aligned installment plans.
import { describe, expect, it } from "vitest";
import { addDays } from "../../src/clock.ts";
import { inferPaycheckCadence, planInstallments } from "../../src/money/paymentPlan.ts";

function every(start: string, step: number, until: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= until; d = addDays(d, step)) out.push(d);
  return out;
}

function previousBusinessDay(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 6 ? addDays(day, -1) : dow === 0 ? addDays(day, -2) : day;
}

function monthly(days: (number | "last")[], months: string[]): string[] {
  return months.flatMap((ym) =>
    days.map((d) => {
      const last = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
      return previousBusinessDay(`${ym}-${String(d === "last" ? last : d).padStart(2, "0")}`);
    }),
  );
}

const APR_TO_SEP = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];

describe("inferPaycheckCadence", () => {
  it("detects weekly Friday pay and projects it", () => {
    const c = inferPaycheckCadence(every("2026-07-03", 7, "2026-10-09"));
    expect(c.kind).toBe("weekly");
    expect(c.lastPayday).toBe("2026-10-09");
    expect(c.nextPaydays("2026-10-10", "2026-11-01")).toEqual(["2026-10-16", "2026-10-23", "2026-10-30"]);
  });

  it("stays weekly through a missed payday and an off-cycle bonus", () => {
    const days = every("2026-07-03", 7, "2026-10-09").filter((d) => d !== "2026-08-14");
    days.push("2026-08-19");
    expect(inferPaycheckCadence(days.sort()).kind).toBe("weekly");
  });

  it("detects biweekly pay, including a holiday-shifted payday", () => {
    const days = every("2026-04-03", 14, "2026-10-09");
    const c = inferPaycheckCadence(days);
    expect(c.kind).toBe("biweekly");
    expect(c.nextPaydays("2026-10-10", "2026-11-30")).toEqual(["2026-10-16", "2026-10-30", "2026-11-13", "2026-11-27"]);

    const shifted = days.map((d) => (d === "2026-07-03" ? "2026-07-02" : d));
    expect(inferPaycheckCadence(shifted).kind).toBe("biweekly");
  });

  it("does not mistake a strict 14-day rhythm for semimonthly pay", () => {
    expect(inferPaycheckCadence(["2026-02-13", "2026-02-27", "2026-03-13", "2026-03-27", "2026-04-10"]).kind).toBe("biweekly");
  });

  it("detects 1st/15th pay with weekend shifts and projects business days", () => {
    const c = inferPaycheckCadence(monthly([1, 15], APR_TO_SEP));
    expect(c.kind).toBe("semimonthly");
    expect(c.lastPayday).toBe("2026-09-15");
    // Nov 1 and Nov 15 2026 are Sundays.
    expect(c.nextPaydays("2026-10-10", "2026-12-01")).toEqual(["2026-10-15", "2026-10-30", "2026-11-13", "2026-12-01"]);
  });

  it("detects 15th/last-day pay", () => {
    const c = inferPaycheckCadence(monthly([15, "last"], APR_TO_SEP));
    expect(c.kind).toBe("semimonthly");
    expect(c.nextPaydays("2026-10-10", "2026-11-30")).toEqual(["2026-10-15", "2026-10-30", "2026-11-13", "2026-11-30"]);
  });

  it("detects monthly pay on a fixed day", () => {
    const c = inferPaycheckCadence(monthly([25], APR_TO_SEP));
    expect(c.kind).toBe("monthly");
    expect(c.lastPayday).toBe("2026-09-25");
    expect(c.nextPaydays("2026-10-10", "2026-12-31")).toEqual(["2026-10-23", "2026-11-25", "2026-12-25"]);
  });

  it("falls back to irregular and guesses every 14 days from the last payday", () => {
    const days = ["2026-04-03", "2026-04-21", "2026-05-09", "2026-06-02", "2026-06-28", "2026-07-06", "2026-08-13", "2026-08-29", "2026-09-11", "2026-09-30"];
    const c = inferPaycheckCadence(days);
    expect(c.kind).toBe("irregular");
    expect(c.nextPaydays("2026-10-10", "2026-11-15")).toEqual(["2026-10-14", "2026-10-28", "2026-11-11"]);
  });

  it("handles no or one payday and unsorted, duplicated input", () => {
    const none = inferPaycheckCadence([]);
    expect(none).toMatchObject({ kind: "irregular", lastPayday: null });
    expect(none.nextPaydays("2026-10-10", "2026-12-01")).toEqual([]);
    expect(inferPaycheckCadence(["2026-10-02"]).nextPaydays("2026-10-01", "2026-10-31")).toEqual(["2026-10-02", "2026-10-16", "2026-10-30"]);
    const messy = [...every("2026-04-03", 14, "2026-10-09")].reverse();
    messy.push("2026-06-12", "not-a-date");
    expect(inferPaycheckCadence(messy).kind).toBe("biweekly");
  });

  it("includes the last payday when it falls inside the range", () => {
    const c = inferPaycheckCadence(every("2026-07-03", 7, "2026-10-09"));
    expect(c.nextPaydays("2026-10-09", "2026-10-16")).toEqual(["2026-10-09", "2026-10-16"]);
    expect(c.nextPaydays("2026-10-20", "2026-10-10")).toEqual([]);
  });
});

describe("planInstallments", () => {
  const today = "2026-10-10";
  const biweekly = inferPaycheckCadence(every("2026-04-03", 14, "2026-10-09"));

  it("bills the day after each payday up to the deadline, split equally", () => {
    const plan = planInstallments({ shareCents: 30_000, today, deadline: "2026-11-30", paydays: biweekly.nextPaydays(today, "2026-11-30") });
    expect(plan).toEqual([
      { dueDate: "2026-10-17", amountCents: 7500 },
      { dueDate: "2026-10-31", amountCents: 7500 },
      { dueDate: "2026-11-14", amountCents: 7500 },
      { dueDate: "2026-11-28", amountCents: 7500 },
    ]);
  });

  it("puts remainder cents on the first installment so the sum is exact", () => {
    const plan = planInstallments({ shareCents: 10_001, today, deadline: "2026-11-30", paydays: biweekly.nextPaydays(today, "2026-11-30") });
    expect(plan.map((i) => i.amountCents)).toEqual([2501, 2500, 2500, 2500]);
  });

  it("takes the earliest slots when there are more paydays than installments", () => {
    const weekly = every("2026-10-16", 7, "2026-11-27");
    expect(planInstallments({ shareCents: 40_000, today, deadline: "2026-11-30", paydays: weekly }).map((i) => i.dueDate)).toEqual([
      "2026-10-17",
      "2026-10-24",
      "2026-10-31",
      "2026-11-07",
    ]);
    expect(planInstallments({ shareCents: 40_000, today, deadline: "2026-11-30", paydays: weekly, maxInstallments: 2 })).toEqual([
      { dueDate: "2026-10-17", amountCents: 20_000 },
      { dueDate: "2026-10-24", amountCents: 20_000 },
    ]);
  });

  it("merges into fewer installments rather than any below the minimum", () => {
    const paydays = biweekly.nextPaydays(today, "2026-11-30");
    expect(planInstallments({ shareCents: 6000, today, deadline: "2026-11-30", paydays })).toEqual([
      { dueDate: "2026-10-17", amountCents: 3000 },
      { dueDate: "2026-10-31", amountCents: 3000 },
    ]);
    expect(planInstallments({ shareCents: 6000, today, deadline: "2026-11-30", paydays, minInstallmentCents: 1000 })).toHaveLength(4);
    expect(planInstallments({ shareCents: 2000, today, deadline: "2026-11-30", paydays })).toEqual([{ dueDate: "2026-10-17", amountCents: 2000 }]);
  });

  it("keeps due dates after today and on or before the deadline", () => {
    const plan = planInstallments({
      shareCents: 30_000,
      today,
      deadline: "2026-11-30",
      paydays: ["2026-10-05", "2026-10-10", "2026-11-29", "2026-11-30"],
    });
    expect(plan.map((i) => i.dueDate)).toEqual(["2026-10-11", "2026-11-30"]);
  });

  it("falls back to one installment tomorrow (or at the deadline) when no payday fits", () => {
    expect(planInstallments({ shareCents: 12_345, today, deadline: "2026-11-30", paydays: [] })).toEqual([{ dueDate: "2026-10-11", amountCents: 12_345 }]);
    expect(planInstallments({ shareCents: 12_345, today, deadline: today, paydays: ["2026-10-20"] })).toEqual([{ dueDate: today, amountCents: 12_345 }]);
    expect(planInstallments({ shareCents: 0, today, deadline: "2026-11-30", paydays: [] })).toEqual([]);
  });

  it("always sums exactly and respects the limits", () => {
    const weekly = every("2026-10-16", 7, "2026-12-25");
    for (const share of [1, 2499, 2500, 4999, 5000, 7777, 10_003, 99_999, 123_457]) {
      for (const max of [1, 3, 4, 6]) {
        const plan = planInstallments({ shareCents: share, today, deadline: "2026-12-31", paydays: weekly, maxInstallments: max });
        expect(plan.reduce((s, i) => s + i.amountCents, 0)).toBe(share);
        expect(plan.length).toBeLessThanOrEqual(max);
        if (plan.length > 1) for (const i of plan) expect(i.amountCents).toBeGreaterThanOrEqual(2500);
        expect([...plan].map((i) => i.dueDate).sort()).toEqual(plan.map((i) => i.dueDate));
      }
    }
  });
});
