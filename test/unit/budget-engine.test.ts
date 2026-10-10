// Budget engine: each formula line on hand-built ledgers, Atlas-object exclusion, and the
// synthetic personas run end to end through the engine.
import { describe, expect, it } from "vitest";
import { computeBudget, poolBudgets, type BudgetInput, type LedgerTxn, type RecurringBill, type TxnKind } from "../../src/money/budget.ts";
import { generateProfile, PERSONA_IDS, profileToLedger, type PersonaId } from "../../src/nessie/personas.ts";

const AS_OF = "2026-10-10";
const MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const usd = (dollars: number) => Math.round(dollars * 100);

function txn(kind: TxnKind, date: string, dollars: number, description: string, accountId = "chk"): LedgerTxn {
  return { accountId, kind, date, amountCents: usd(dollars), description };
}
function bill(payee: string, dollars: number, status: RecurringBill["status"] = "recurring", description?: string): RecurringBill {
  return { accountId: "chk", payee, amountCents: usd(dollars), recurringDay: 1, status, description };
}

/** $3,000 paycheck + $500 of purchases every window month, $1,250 of bills: $1,250/mo free. */
function baseLedger(opts: { checking?: number; savings?: number; paycheck?: number } = {}): BudgetInput {
  const txns: LedgerTxn[] = [];
  for (const m of MONTHS) {
    txns.push(txn("deposit", `${m}-15`, opts.paycheck ?? 3000, "Payroll: Acme Widgets"));
    txns.push(txn("purchase", `${m}-03`, 200, "Debit purchase at Greenleaf Grocers"));
    txns.push(txn("purchase", `${m}-20`, 300, "Debit purchase at Gadget Grove"));
  }
  return {
    asOf: AS_OF,
    accounts: [
      { id: "chk", type: "Checking", openingBalanceCents: usd(opts.checking ?? 10_000) },
      { id: "sav", type: "Savings", openingBalanceCents: usd(opts.savings ?? 0) },
      { id: "cc", type: "Credit Card", openingBalanceCents: usd(800) },
    ],
    txns,
    bills: [bill("Maple Court Apartments", 1200), bill("Sandbox Wireless", 50)],
  };
}

describe("line 1: monthly free", () => {
  it("is median paychecks minus recurring bills minus median purchases over complete months", () => {
    const input = baseLedger();
    input.txns.push(txn("deposit", "2026-07-30", 5000, "Payroll: Acme Widgets bonus"));
    input.txns.push(txn("purchase", "2026-08-09", 2000, "Debit purchase at Skyhop Air"));
    input.txns.push(txn("deposit", "2026-06-02", 400, "Venmo cashout"));
    input.bills.push(bill("Old Gym", 999, "completed"), bill("Cancelled Box", 999, "cancelled"), bill("One-off", 999, "pending"));

    const r = computeBudget(input);
    expect(r.monthlyIncomeCents).toBe(usd(3000));
    expect(r.monthlyDiscretionaryCents).toBe(usd(500));
    expect(r.monthlyBillsCents).toBe(usd(1250));
    expect(r.monthlyFreeCents).toBe(usd(1250));
    expect(r.counts).toEqual({ paychecks: 7, purchases: 13, bills: 2 });
    expect(r.window).toEqual({ start: "2026-04-01", end: "2026-09-30" });
  });

  it("recognizes payroll, paycheck, salary and direct deposit descriptions in any case", () => {
    const input = baseLedger();
    input.txns = input.txns.filter((t) => t.kind !== "deposit");
    const labels = ["ACME PAYROLL", "Paycheck", "monthly salary", "DIRECT DEPOSIT acme", "Direct Dep: Acme", "payroll"];
    MONTHS.forEach((m, i) => input.txns.push(txn("deposit", `${m}-15`, 3000, labels[i]!)));
    expect(computeBudget(input).monthlyIncomeCents).toBe(usd(3000));
    expect(computeBudget(input).counts.paychecks).toBe(6);
  });

  it("ignores the current month and months before the window", () => {
    const input = baseLedger();
    input.txns.push(txn("deposit", "2026-10-02", 9999, "Payroll: Acme Widgets"));
    input.txns.push(txn("purchase", "2026-10-05", 9999, "Debit purchase at Gadget Grove"));
    input.txns.push(txn("deposit", "2026-03-02", 9999, "Payroll: Acme Widgets"));
    const r = computeBudget(input);
    expect(r.monthlyIncomeCents).toBe(usd(3000));
    expect(r.monthlyDiscretionaryCents).toBe(usd(500));
    expect(r.window).toEqual({ start: "2026-04-01", end: "2026-09-30" });
  });

  it("counts credit card purchases as discretionary spending", () => {
    const input = baseLedger();
    for (const m of MONTHS) input.txns.push(txn("purchase", `${m}-25`, 100, "Card purchase at Noodle Theory", "cc"));
    expect(computeBudget(input).monthlyDiscretionaryCents).toBe(usd(600));
  });

  it("uses the median month for irregular income, including a month with no pay", () => {
    const input = baseLedger();
    input.txns = input.txns.filter((t) => t.kind !== "deposit");
    const totals = [1200, 4800, 3000, 0, 5200, 2600];
    MONTHS.forEach((m, i) => {
      if (totals[i]! === 0) return;
      input.txns.push(txn("deposit", `${m}-09`, totals[i]! / 2, "Payroll: Pinecone Creative invoice 1"));
      input.txns.push(txn("deposit", `${m}-23`, totals[i]! / 2, "Payroll: Bluebird Media invoice 2"));
    });
    const r = computeBudget(input);
    expect(r.monthlyIncomeCents).toBe(usd(2800)); // (2600 + 3000) / 2
    expect(r.monthlyFreeCents).toBe(usd(2800 - 1250 - 500));
  });

  it("trims the window to the months the ledger actually covers", () => {
    const short = baseLedger();
    short.txns = short.txns.filter((t) => t.date >= "2026-07-01");
    expect(computeBudget(short).window).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(computeBudget(short).monthlyIncomeCents).toBe(usd(3000));

    // History starting late in July: July is partial, so it is skipped.
    const partial = baseLedger();
    partial.txns = partial.txns.filter((t) => t.date >= "2026-07-15");
    expect(computeBudget(partial).window).toEqual({ start: "2026-08-01", end: "2026-09-30" });
  });
});

describe("line 2: suggested", () => {
  const suggestedFor = (tripStart: string | null | undefined, safeFraction?: number) =>
    computeBudget({ ...baseLedger(), tripStart, safeFraction });

  it("counts one month when the trip date is unknown", () => {
    const r = suggestedFor(undefined);
    expect(r.monthsUntilTrip).toBe(1);
    expect(r.suggestedCents).toBe(usd(625));
    expect(suggestedFor(null).suggestedCents).toBe(usd(625));
  });

  it("multiplies by whole months until the trip (days / 30.44, floored)", () => {
    expect(suggestedFor("2026-11-12").monthsUntilTrip).toBe(1); // 33 days
    const r = suggestedFor("2027-01-15"); // 97 days -> 3.19
    expect(r.monthsUntilTrip).toBe(3);
    expect(r.suggestedCents).toBe(usd(1250 * 3 * 0.5));
  });

  it("clamps months to 1..6", () => {
    expect(suggestedFor("2028-01-01").monthsUntilTrip).toBe(6);
    expect(suggestedFor("2026-10-20").monthsUntilTrip).toBe(1);
    expect(suggestedFor("2026-09-01").monthsUntilTrip).toBe(1);
  });

  it("applies the safe fraction", () => {
    const r = suggestedFor("2027-01-15", 0.25);
    expect(r.safeFraction).toBe(0.25);
    expect(r.suggestedCents).toBe(usd(1250 * 3 * 0.25));
    expect(r.explanation[1]).toContain("25%");
  });
});

describe("line 3: balance cap, floor and rounding", () => {
  /** Same income and spending, but rent, phone and a $1,000 transfer out actually leave checking. */
  function tightLedger(openingChecking: number): BudgetInput {
    const input = baseLedger({ checking: openingChecking });
    for (const m of MONTHS) {
      input.txns.push(txn("bill_payment", `${m}-01`, 1200, "Maple Court Apartments"));
      input.txns.push(txn("bill_payment", `${m}-09`, 50, "Sandbox Wireless"));
      input.txns.push(txn("transfer_out", `${m}-28`, 1000, "Transfer to brokerage"));
    }
    return input; // liquid = opening + 6 x (3000 - 500 - 1250 - 1000) = opening + 1500
  }

  it("caps the budget at liquid balance minus one month of bills", () => {
    const r = computeBudget({ ...tightLedger(310), tripStart: "2026-11-12" });
    expect(r.liquidBalanceCents).toBe(usd(1810));
    expect(r.capCents).toBe(usd(560));
    expect(r.suggestedCents).toBe(usd(625));
    expect(r.budgetCents).toBe(usd(550)); // 560 floored to $25
    expect(r.explanation[2]).toContain("caps it at $560");
  });

  it("floors at $0 when bills and spending exceed income", () => {
    const input = baseLedger();
    input.bills.push(bill("Harborview Towers", 2250));
    const r = computeBudget(input);
    expect(r.monthlyFreeCents).toBe(usd(-1000));
    expect(r.suggestedCents).toBe(usd(-500));
    expect(r.budgetCents).toBe(0);
    expect(r.explanation[2]).toContain("$0");
  });

  it("floors at $0 when the balance does not cover next month's bills", () => {
    const r = computeBudget(tightLedger(-500));
    expect(r.capCents).toBe(usd(1000 - 1250));
    expect(r.budgetCents).toBe(0);
    expect(r.explanation[2]).toContain("$0");
  });

  it("rounds down to a multiple of $25", () => {
    const r = computeBudget(baseLedger({ paycheck: 3087.4 }));
    expect(r.suggestedCents).toBe(usd(668.7));
    expect(r.budgetCents).toBe(usd(650));
    expect(r.explanation[2]).toContain("rounded down to the nearest $25");
  });

  it("replays checking + savings only, ignoring credit cards and future-dated transactions", () => {
    const input: BudgetInput = {
      asOf: AS_OF,
      accounts: [
        { id: "chk", type: "Checking", openingBalanceCents: usd(1000) },
        { id: "sav", type: "Savings", openingBalanceCents: usd(2000) },
        { id: "cc", type: "Credit Card", openingBalanceCents: usd(300) },
      ],
      txns: [
        txn("deposit", "2026-09-01", 500, "Payroll: Acme"),
        txn("transfer_in", "2026-09-02", 50, "From a friend", "sav"),
        txn("purchase", "2026-09-03", 40, "Debit purchase"),
        txn("withdrawal", "2026-09-04", 60, "ATM"),
        txn("transfer_out", "2026-09-05", 70, "To brokerage", "sav"),
        txn("bill_payment", "2026-09-06", 80, "Rent"),
        txn("purchase", "2026-09-07", 999, "Card purchase", "cc"),
        txn("deposit", "2026-10-11", 9999, "Payroll: Acme"),
      ],
      bills: [],
    };
    expect(computeBudget(input).liquidBalanceCents).toBe(usd(1000 + 2000 + 500 + 50 - 40 - 60 - 70 - 80));
  });
});

describe("[atlas] objects", () => {
  function withAtlasObjects(): BudgetInput {
    const input = baseLedger();
    input.txns.push(
      txn("purchase", "2026-08-12", 600, "[atlas] trip purchase: Blue Ridge cabin deposit"),
      txn("deposit", "2026-09-15", 700, "[atlas] settle-up payroll-style refund from Sam"),
      txn("transfer_in", "2026-09-16", 150, "[atlas] settle-up from Riley"),
      txn("transfer_out", "2026-09-17", 80, "  [ATLAS] settle-up to Jordan"),
    );
    input.bills.push(bill("Atlas trip fund", 200, "recurring", "[atlas] installment 1/3"), bill("[atlas] trip fund", 100));
    return input;
  }

  it("never count toward income, recurring bills or discretionary spending", () => {
    const r = computeBudget(withAtlasObjects());
    expect(r.monthlyIncomeCents).toBe(usd(3000));
    expect(r.monthlyBillsCents).toBe(usd(1250));
    expect(r.monthlyDiscretionaryCents).toBe(usd(500));
    expect(r.counts).toEqual({ paychecks: 6, purchases: 12, bills: 2 });
  });

  it("do move the liquid balance, because that money really moved", () => {
    const plain = computeBudget(baseLedger()).liquidBalanceCents;
    expect(computeBudget(withAtlasObjects()).liquidBalanceCents).toBe(plain + usd(-600 + 700 + 150 - 80));
  });

  it("do not stretch the window back on their own", () => {
    const input = baseLedger();
    input.txns = input.txns.filter((t) => t.date >= "2026-07-01");
    input.txns.push(txn("purchase", "2026-04-02", 50, "[atlas] old trip purchase"));
    expect(computeBudget(input).window.start).toBe("2026-07-01");
  });
});

describe("explanation", () => {
  it("is three plain lowercase chat lines with formatted dollars", () => {
    const r = computeBudget({ ...baseLedger(), tripStart: "2026-11-12" });
    expect(r.budgetCents).toBe(usd(625));
    expect(r.explanation).toEqual([
      "you typically bring in $3,000/mo and recurring bills take $1,250; after ~$500/mo of everyday spending, about $1,250/mo is free",
      "the trip is about 1 month away, and setting aside half of that each month gives $625",
      "your checking + savings ($25,000) still covers next month's bills after that, so your budget is $625",
    ]);
    for (const line of r.explanation) expect(line).toBe(line.toLowerCase());
  });

  it("explains unknown, far-off and imminent trip dates", () => {
    expect(computeBudget(baseLedger()).explanation[1]).toContain("no trip date yet");
    expect(computeBudget({ ...baseLedger(), tripStart: "2027-08-01" }).explanation[1]).toContain("i only count 6");
    expect(computeBudget({ ...baseLedger(), tripStart: "2026-10-20" }).explanation[1]).toContain("less than a month away");
  });

  it("says so plainly when there are no paychecks", () => {
    const input = baseLedger();
    input.txns = input.txns.filter((t) => t.kind !== "deposit");
    const r = computeBudget(input);
    expect(r.budgetCents).toBe(0);
    expect(r.explanation[0]).toBe("i don't see any paychecks in your last 6 months, and recurring bills take $1,250/mo");
  });
});

describe("poolBudgets", () => {
  it("summarizes min, max and the ceiling (the smallest budget)", () => {
    const pool = poolBudgets([
      { personId: 1, budgetCents: usd(450), visibility: "public" },
      { personId: 2, budgetCents: usd(1200), visibility: "public" },
      { personId: 3, budgetCents: usd(300), visibility: "private" },
    ]);
    expect(pool).toEqual({ minCents: usd(300), maxCents: usd(1200), ceilingCents: usd(300), count: 3, anyPrivate: true, canShowRange: true });
  });

  it("hides the range when it would reveal a private budget or there is only one person", () => {
    const pub = (personId: number, dollars: number) => ({ personId, budgetCents: usd(dollars), visibility: "public" as const });
    expect(poolBudgets([pub(1, 400), { personId: 2, budgetCents: usd(900), visibility: "private" }]).canShowRange).toBe(false);
    expect(poolBudgets([pub(1, 400), pub(2, 900)]).canShowRange).toBe(true);
    expect(poolBudgets([pub(1, 400)]).canShowRange).toBe(false);
    expect(poolBudgets([])).toEqual({ minCents: 0, maxCents: 0, ceilingCents: 0, count: 0, anyPrivate: false, canShowRange: false });
  });
});

describe("synthetic personas through the engine", () => {
  const SEEDS = ["alpha", "bravo", "charlie", "delta", "echo"];
  const budgetFor = (seedKey: string, persona: PersonaId, months = 6) => {
    const profile = generateProfile({ seedKey, persona, months, asOf: AS_OF });
    return computeBudget({ asOf: AS_OF, tripStart: "2026-11-12", ...profileToLedger(profile) });
  };

  it.each(SEEDS)("orders budgets sensibly for seed %s", (seed) => {
    const b = Object.fromEntries(PERSONA_IDS.map((p) => [p, budgetFor(seed, p)])) as Record<PersonaId, ReturnType<typeof computeBudget>>;
    expect(b.new_grad_engineer.budgetCents).toBeGreaterThan(b.nurse_high_rent.budgetCents);
    expect(b.nurse_high_rent.budgetCents).toBeGreaterThan(b.grad_ta.budgetCents);
    expect(b.grad_ta.budgetCents).toBeGreaterThan(b.barista_student.budgetCents);
    expect(b.big_saver.budgetCents).toBeGreaterThan(b.nurse_high_rent.budgetCents);

    expect(b.barista_student.budgetCents).toBeGreaterThanOrEqual(usd(100));
    expect(b.barista_student.budgetCents).toBeLessThanOrEqual(usd(300));
    expect(b.nurse_high_rent.budgetCents).toBeGreaterThanOrEqual(usd(300));
    expect(b.nurse_high_rent.budgetCents).toBeLessThanOrEqual(usd(600));
    expect(b.new_grad_engineer.budgetCents).toBeGreaterThanOrEqual(usd(1400));
    // The engineer invests everything above a thin cushion, so the balance cap binds.
    expect(b.new_grad_engineer.suggestedCents).toBeGreaterThan(b.new_grad_engineer.capCents);
    expect(b.big_saver.liquidBalanceCents).toBeGreaterThan(usd(20_000));
    expect(b.freelancer.budgetCents).toBeGreaterThanOrEqual(0);
    for (const r of Object.values(b)) {
      expect(r.budgetCents % 2500).toBe(0);
      expect(r.window).toEqual({ start: "2026-04-01", end: "2026-09-30" });
    }
  });

  it("gives the freelancer visibly lumpier income than salaried personas", () => {
    const spread = (persona: PersonaId) => {
      const incomes = SEEDS.map((s) => budgetFor(s, persona).monthlyIncomeCents);
      return Math.max(...incomes) - Math.min(...incomes);
    };
    expect(spread("freelancer")).toBeGreaterThan(spread("nurse_high_rent") * 3);
    expect(spread("grad_ta")).toBe(0);
  });

  it("keeps budgets stable across 6 and 12 months of history", () => {
    for (const persona of ["barista_student", "grad_ta", "nurse_high_rent", "big_saver"] as const) {
      const six = budgetFor("alpha", persona, 6).budgetCents;
      const twelve = budgetFor("alpha", persona, 12).budgetCents;
      expect(Math.abs(six - twelve)).toBeLessThanOrEqual(usd(50));
    }
  });
});

// Run with PRINT_BUDGETS=1 to see every persona's numbers.
describe.skipIf(!process.env.PRINT_BUDGETS)("persona budget table", () => {
  it("prints", () => {
    const rows = PERSONA_IDS.map((persona) => {
      const r = computeBudget({ asOf: AS_OF, tripStart: "2026-11-12", ...profileToLedger(generateProfile({ seedKey: "demo", persona, months: 6, asOf: AS_OF })) });
      const d = (c: number) => Math.round(c) / 100;
      return {
        persona,
        budget: d(r.budgetCents),
        suggested: d(r.suggestedCents),
        cap: d(r.capCents),
        income: d(r.monthlyIncomeCents),
        bills: d(r.monthlyBillsCents),
        spend: d(r.monthlyDiscretionaryCents),
        free: d(r.monthlyFreeCents),
        liquid: d(r.liquidBalanceCents),
      };
    });
    console.table(rows);
  });
});
