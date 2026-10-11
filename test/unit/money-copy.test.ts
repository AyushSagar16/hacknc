import { describe, expect, it } from "vitest";
import { scheduleText, targetText, whenText } from "../../src/agent/features/fund.ts";
import { contributionPlanKey } from "../../src/trips/fund.ts";
import { budgetMessage } from "../../src/agent/features/budgets.ts";
import type { BudgetRow } from "../../src/nessie/budgets.ts";

const names: Record<number, string> = { 1: "Maya", 2: "Leo", 3: "Priya", 4: "Dev", 5: "Tess", 6: "Sol" };
const label = (id: number) => names[id]!;

describe("trip fund copy", () => {
  it("one short schedule per person", () => {
    expect(scheduleText({ shareCents: 400_00, contributedCents: 0, plan: [{ dueDate: "2026-10-17", amountCents: 200_00 }, { dueDate: "2026-10-31", amountCents: 200_00 }] })).toBe("2 × $200 (oct 17, oct 31)");
    expect(scheduleText({ shareCents: 100_00, contributedCents: 0, plan: [{ dueDate: "2026-10-17", amountCents: 100_00 }] })).toBe("$100 on oct 17");
    expect(scheduleText({ shareCents: 100_00, contributedCents: 0, plan: [{ dueDate: "2026-10-17", amountCents: 60_00 }, { dueDate: "2026-10-31", amountCents: 40_00 }] })).toBe("$60 oct 17, $40 oct 31");
    expect(scheduleText({ shareCents: 100_00, contributedCents: 100_00, plan: [] })).toBe("all in ✓");
  });

  it("names what the fund pays for", () => {
    expect(targetText([{ kind: "stay", description: "Harleston Village Townhouse", amount_cents: 1240_00 }, { kind: "item", description: "Boat rental", amount_cents: 240_00 }])).toBe("$1,240 for the stay + $240 boat rental");
  });

  it("says a weekday within the week, a date after", () => {
    expect(whenText("2026-10-16", "2026-10-10")).toBe("friday");
    expect(whenText("2026-10-11", "2026-10-10")).toBe("tomorrow");
    expect(whenText("2026-10-24", "2026-10-10")).toBe("oct 24");
  });

  it("the same share and deadline are the same plan", () => {
    expect(contributionPlanKey(400_00, "2026-10-29")).toBe(contributionPlanKey(400_00, "2026-10-29"));
    expect(contributionPlanKey(400_00, "2026-10-29")).not.toBe(contributionPlanKey(480_00, "2026-10-29"));
  });
});

describe("budget message", () => {
  const row = (person_id: number, cents: number, visibility: "public" | "private" = "public", announced = true): BudgetRow =>
    ({ person_id, suggested_cents: cents, adjusted_cents: null, visibility, announced_at: announced ? new Date() : null, inputs: { source: "offline-profile" } }) as unknown as BudgetRow;

  it("says where the numbers come from once, not on every re-post", () => {
    const rows = [row(1, 900_00, "public", false), row(2, 700_00, "public", false)];
    expect(budgetMessage(rows, label, { firstTime: true }).join("\n")).toContain("last few months of spending");
    expect(budgetMessage(rows, label, { firstTime: false }).join("\n")).not.toContain("last few months of spending");
  });

  it("private by default: the group sees only the pooled number, never a name with a figure", () => {
    const three = [row(1, 900_00, "private", false), row(2, 700_00, "private", false), row(3, 450_00, "private", false)];
    const text = budgetMessage(three, label, { firstTime: true }).join("\n");
    expect(text).toContain("💰 budgets stay private, so here's just the pooled number:\neveryone's good up to $450 each");
    expect(text).toContain('"share my budget"');
    expect(text).not.toMatch(/\$900|\$700/);
    expect(text).not.toMatch(/[a-z]+: \$/);
  });

  it("with only two people (or one) even the pooled number would give a budget away", () => {
    const two = budgetMessage([row(1, 900_00, "private"), row(2, 700_00, "private")], label, { firstTime: false }).join("\n");
    expect(two).toContain("budgets stay private between you two");
    expect(two).not.toContain("$");
    const one = budgetMessage([row(1, 900_00, "private")], label, { firstTime: false }).join("\n");
    expect(one).toContain("it stays private");
    expect(one).not.toContain("$");
  });

  it("one person sharing doesn't expose the rest: still pooled only", () => {
    const rows = [row(1, 900_00, "public"), row(2, 700_00, "private"), row(3, 450_00, "private")];
    const text = budgetMessage(rows, label, { firstTime: false }).join("\n");
    expect(text).toContain("here's just the pooled number");
    expect(text).not.toMatch(/\$900|\$700/);
  });

  it("never claims the locked plan works for everyone when it's over someone's budget", () => {
    const rows = [row(1, 900_00), row(6, 700_00)];
    const text = budgetMessage(rows, label, { firstTime: false, planTotals: new Map([[1, 1415_00], [6, 1415_00]]) }).join("\n");
    expect(text).toContain("heads up: the locked plan is over budget for maya and sol");
    expect(text).not.toContain("works for everyone");
    const fits = budgetMessage(rows, label, { firstTime: false, planTotals: new Map([[1, 500_00], [6, 500_00]]) }).join("\n");
    expect(fits).toContain("the locked plan fits everyone's budget");
  });
});
