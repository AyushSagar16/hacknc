import { describe, expect, it } from "vitest";
import { balances, merchantOf, nextDue, parseBankQuery, parseTransfer, recentTransactions, spending, upcomingBills, type Ledger } from "../../src/money/bank.ts";

const ledger: Ledger = {
  accounts: [
    { id: "c", type: "Checking", openingBalanceCents: 100_000 },
    { id: "s", type: "Savings", openingBalanceCents: 50_000 },
    { id: "cc", type: "Credit Card", openingBalanceCents: 0 },
  ],
  txns: [
    { accountId: "c", kind: "deposit", date: "2026-09-01", amountCents: 200_000, description: "Payroll: Acme" },
    { accountId: "c", kind: "purchase", date: "2026-09-05", amountCents: 4_000, description: "Debit purchase at Trader Joe's" },
    { accountId: "c", kind: "withdrawal", date: "2026-09-20", amountCents: 30_000, description: "Autopay" },
    { accountId: "cc", kind: "purchase", date: "2026-09-28", amountCents: 2_500, description: "Card purchase at Chipotle" },
    { accountId: "cc", kind: "purchase", date: "2026-10-02", amountCents: 1_500, description: "Card purchase at Chipotle" },
    { accountId: "c", kind: "transfer_out", date: "2026-10-03", amountCents: 10_000, description: "[atlas] move to savings" },
    { accountId: "s", kind: "transfer_in", date: "2026-10-03", amountCents: 10_000, description: "[atlas] move to savings" },
    { accountId: "c", kind: "purchase", date: "2026-10-04", amountCents: 6_000, description: "Debit purchase at Trader Joe's" },
    { accountId: "c", kind: "purchase", date: "2026-10-20", amountCents: 9_999, description: "Debit purchase at the future" },
  ],
  bills: [
    { accountId: "c", payee: "Verizon Wireless", amountCents: 8_500, recurringDay: 15, status: "recurring" },
    { accountId: "c", payee: "Rent", amountCents: 120_000, recurringDay: 1, status: "recurring" },
    { accountId: "c", payee: "Old gym", amountCents: 4_000, recurringDay: 12, status: "cancelled" },
    { accountId: "c", payee: "[atlas] trip installment", amountCents: 5_000, recurringDay: 11, status: "recurring" },
  ],
};

describe("balances", () => {
  it("replays checking and savings up to today; a card shows this month's charges", () => {
    expect(balances(ledger, "2026-10-10")).toEqual([
      { id: "c", type: "Checking", cents: 100_000 + 200_000 - 4_000 - 30_000 - 10_000 - 6_000 },
      { id: "s", type: "Savings", cents: 60_000 },
      { id: "cc", type: "Credit Card", cents: 1_500 },
    ]);
  });
});

describe("spending", () => {
  it("sums purchases in the window by merchant and compares with the window before", () => {
    const s = spending(ledger, "2026-10-10", 30);
    expect(s.from).toBe("2026-09-11");
    expect(s.totalCents).toBe(2_500 + 1_500 + 6_000);
    expect(s.count).toBe(3);
    expect(s.byMerchant).toEqual([
      { name: "Trader Joe's", cents: 6_000, count: 1 },
      { name: "Chipotle", cents: 4_000, count: 2 },
    ]);
    expect(s.previousCents).toBe(4_000);
  });

  it("reads merchants out of purchase descriptions", () => {
    expect(merchantOf("Card purchase at Cook Out")).toBe("Cook Out");
    expect(merchantOf("[atlas] Gatlinburg dinner")).toBe("Gatlinburg dinner");
    expect(merchantOf("Venmo")).toBe("Venmo");
  });
});

describe("bills", () => {
  it("lists recurring bills due in the window, soonest first, skipping cancelled and atlas's own", () => {
    expect(upcomingBills(ledger.bills, "2026-10-10")).toEqual([
      { payee: "Verizon Wireless", cents: 8_500, due: "2026-10-15" },
      { payee: "Rent", cents: 120_000, due: "2026-11-01" },
    ]);
    expect(upcomingBills(ledger.bills, "2026-10-10", 7)).toEqual([{ payee: "Verizon Wireless", cents: 8_500, due: "2026-10-15" }]);
  });

  it("finds the next due day, clamped to short months and rolling over the year", () => {
    expect(nextDue("2026-10-10", 10)).toBe("2026-10-10");
    expect(nextDue("2026-02-10", 31)).toBe("2026-02-28");
    expect(nextDue("2026-12-20", 5)).toBe("2027-01-05");
  });
});

describe("recent transactions", () => {
  it("newest first, nothing after today", () => {
    const rows = recentTransactions(ledger, "2026-10-10", 3);
    expect(rows.map((r) => [r.date, r.kind, r.accountType])).toEqual([
      ["2026-10-04", "purchase", "Checking"],
      ["2026-10-03", "transfer_in", "Savings"],
      ["2026-10-03", "transfer_out", "Checking"],
    ]);
  });
});

describe("parsing", () => {
  it.each([
    ["what's my balance", "balance"],
    ["how much money do i have", "balance"],
    ["atlas my accounts?", "balance"],
    ["how much did i spend this month", "spending"],
    ["where's my money going", "spending"],
    ["what bills are coming up", "bills"],
    ["when's my rent bill", "bills"],
    ["show me my recent transactions", "transactions"],
    ["what's our budget", null],
    ["let's go to the beach", null],
    ["who owes who", null],
  ])("%s → %s", (text, kind) => {
    expect(parseBankQuery(text)).toBe(kind);
  });

  it.each([
    ["move $50 to savings", { cents: 5_000, from: "checking", to: "savings" }],
    ["atlas can you transfer 1,200 from savings to checking", { cents: 120_000, from: "savings", to: "checking" }],
    ["put 1k in my savings", { cents: 100_000, from: "checking", to: "savings" }],
    ["pull 75.50 out of savings", { cents: 7_550, from: "savings", to: "checking" }],
    ["move 20 bucks to checking from savings", { cents: 2_000, from: "savings", to: "checking" }],
  ])("%s", (text, want) => {
    expect(parseTransfer(text)).toEqual(want);
  });

  it.each(["move to savings", "transfer 50 from savings to savings", "send leo 40", "move the dinner to friday", "put 50 on the fund"])("not a transfer: %s", (text) => {
    expect(parseTransfer(text)).toBeNull();
  });
});
