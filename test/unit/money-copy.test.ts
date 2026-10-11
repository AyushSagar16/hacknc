import { describe, expect, it } from "vitest";
import { compactPlan, overBudgetLine, planFingerprint, whyDifferent } from "../../src/agent/features/money.ts";
import { budgetMessage } from "../../src/agent/features/budgets.ts";
import type { BudgetRow } from "../../src/nessie/budgets.ts";

const names: Record<number, string> = { 1: "Maya", 2: "Leo", 3: "Priya", 4: "Dev", 5: "Tess", 6: "Sol" };
const label = (id: number) => names[id]!;

describe("why shares differ", () => {
  it("names the few who fly instead of 'everyone else'", () => {
    const shares = new Map([[1, 500_00], [2, 500_00], [3, 500_00], [4, 910_00]]);
    const modes = new Map([[1, "drive"], [2, "drive"], [3, "drive"], [4, "flight"]]);
    expect(whyDifferent(shares, modes, label)).toMatch(/^shares differ because travel does \(maya, leo and priya drive, dev flies\)/);
  });

  it("uses 'everyone else' only for a crowd", () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const shares = new Map(ids.map((id) => [id, id === 1 ? 300_00 : 800_00]));
    const modes = new Map(ids.map((id) => [id, id === 1 ? "drive" : "flight"]));
    expect(whyDifferent(shares, modes, label)).toContain("(maya drives, everyone else flies)");
  });

  it("all flying: flights cost different amounts; equal shares: nothing to explain", () => {
    expect(whyDifferent(new Map([[1, 1], [2, 2]]), new Map([[1, "flight"], [2, "flight"]]), label)).toContain("flights cost different amounts from each home city");
    expect(whyDifferent(new Map([[1, 5], [2, 5]]), new Map(), label)).toBeNull();
  });
});

describe("over-budget line", () => {
  it("names public people and never shows a private number", () => {
    const shares = new Map([[4, 910_00], [5, 910_00], [1, 400_00]]);
    const line = overBudgetLine(
      shares,
      [
        { personId: 4, cents: 600_00, private: false },
        { personId: 5, cents: 700_00, private: true },
        { personId: 1, cents: 900_00, private: false },
      ],
      label,
    )!;
    expect(line).toContain("heads up: this is over budget for dev");
    expect(line).toContain("heads up tess, this is above what you said works for you");
    expect(line).not.toMatch(/\$/);
    expect(overBudgetLine(shares, [{ personId: 1, cents: 900_00, private: false }], label)).toBeNull();
  });
});

describe("plan keys and compact lines", () => {
  it("a new destination or share is a new plan; the same inputs are the same plan", () => {
    expect(planFingerprint({ destination_id: "charleston" }, "by_cost", 500_00)).toBe(planFingerprint({ destination_id: "charleston" }, "by_cost", 500_00));
    expect(planFingerprint({ destination_id: "charleston" }, "by_cost", 500_00)).not.toBe(planFingerprint({ destination_id: "savannah" }, "by_cost", 500_00));
    expect(planFingerprint({ destination_id: "charleston" }, "by_cost", 500_00)).not.toBe(planFingerprint({ destination_id: "charleston" }, "even", 500_00));
  });

  it("one short line per person", () => {
    expect(compactPlan({ shareCents: 1415_00, plan: [{ amountCents: 353_75 }, { amountCents: 353_75 }, { amountCents: 353_75 }, { amountCents: 353_75 }] })).toBe("$1,415, 4 × $353.75");
    expect(compactPlan({ shareCents: 100_00, plan: [{ amountCents: 60_00 }, { amountCents: 40_00 }] })).toBe("$100 in 2 payments");
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
