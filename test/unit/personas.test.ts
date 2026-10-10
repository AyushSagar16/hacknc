// Synthetic Nessie profiles: determinism, obviously-fake identities, date bounds, Nessie
// request-body shapes, pay cadences and the ledger conversion.
import { describe, expect, it } from "vitest";
import { inferPaycheckCadence } from "../../src/money/paymentPlan.ts";
import { generateProfile, MERCHANTS, PERSONA_IDS, PERSONAS, pickPersona, profileToLedger, type GeneratedProfile } from "../../src/nessie/personas.ts";

const AS_OF = "2026-10-10";
const CATEGORIES = ["food", "groceries", "transport", "entertainment", "shopping", "health", "travel", "personal_care", "education"];
const keys = (o: object) => Object.keys(o).sort();
const all = (months: number, asOf = AS_OF): GeneratedProfile[] =>
  PERSONA_IDS.flatMap((persona) => ["alpha", "bravo"].map((seedKey) => generateProfile({ seedKey, persona, months, asOf })));

describe("generateProfile", () => {
  it("is deterministic for the same inputs and varies by seed", () => {
    const a = generateProfile({ seedKey: "+15555550123", months: 9, asOf: AS_OF });
    expect(generateProfile({ seedKey: "+15555550123", months: 9, asOf: AS_OF })).toEqual(a);
    const b = generateProfile({ seedKey: "+15555550199", persona: a.persona, months: 9, asOf: AS_OF });
    expect(b.purchases).not.toEqual(a.purchases);
  });

  it("keeps the same synthetic customer for a seed regardless of history length", () => {
    const six = generateProfile({ seedKey: "riley", months: 6, asOf: AS_OF });
    const twelve = generateProfile({ seedKey: "riley", months: 12, asOf: "2026-12-01" });
    expect(twelve.customer).toEqual(six.customer);
  });

  it("uses obviously synthetic names and well-formed addresses", () => {
    for (let i = 0; i < 50; i++) {
      const { customer } = generateProfile({ seedKey: `seed-${i}`, months: 6, asOf: AS_OF });
      expect(customer.last_name).toMatch(/^Atlasdemo[A-Z]$/);
      expect(customer.first_name).toMatch(/^[A-Z][a-z]+$/);
      expect(customer.address.street_number).toMatch(/^\d{3,4}$/);
      expect(customer.address.state).toBe("NC");
      expect(customer.address.zip).toMatch(/^\d{5}$/);
      expect(customer.address.street_name.length).toBeGreaterThan(0);
    }
  });

  it("never dates anything after asOf or before the history start", () => {
    for (const asOf of [AS_OF, "2026-03-01", "2026-12-31"]) {
      for (const p of [...all(6, asOf), ...all(12, asOf)]) {
        const dates = [
          ...p.deposits.map((d) => d.transaction_date),
          ...p.withdrawals.map((w) => w.transaction_date),
          ...p.purchases.map((x) => x.purchase_date),
          ...p.bills.map((b) => b.payment_date),
        ];
        for (const d of dates) {
          expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(d <= asOf).toBe(true);
          expect(d >= p.historyStart).toBe(true);
        }
      }
    }
  });

  it("covers `months` whole months before asOf's month, clamped to 6..12", () => {
    expect(generateProfile({ seedKey: "x", months: 6, asOf: AS_OF }).historyStart).toBe("2026-04-01");
    expect(generateProfile({ seedKey: "x", months: 12, asOf: AS_OF }).historyStart).toBe("2025-10-01");
    expect(generateProfile({ seedKey: "x", months: 2, asOf: AS_OF }).historyStart).toBe("2026-04-01");
    expect(generateProfile({ seedKey: "x", months: 40, asOf: AS_OF }).historyStart).toBe("2025-10-01");
    expect(() => generateProfile({ seedKey: "x", months: 6, asOf: "10/10/2026" })).toThrow(RangeError);
  });

  it("emits Nessie request-body field names and valid values", () => {
    const merchants = new Map(MERCHANTS.map((m) => [m.name, m.category]));
    for (const p of all(6)) {
      expect(p.accounts.map((a) => [a.key, a.type])).toEqual([
        ["checking", "Checking"],
        ["savings", "Savings"],
        ["credit", "Credit Card"],
      ]);
      for (const a of p.accounts) {
        expect(keys(a)).toEqual(["balance", "key", "nickname", "rewards", "type"]);
        expect(Number.isInteger(a.balance) && a.balance >= 0).toBe(true);
        expect(Number.isInteger(a.rewards) && a.rewards >= 0).toBe(true);
      }
      for (const d of [...p.deposits, ...p.withdrawals]) {
        expect(keys(d)).toEqual(["accountKey", "amount", "description", "medium", "status", "transaction_date"]);
        expect(d).toMatchObject({ medium: "balance", status: "completed" });
        expect(Number.isInteger(d.amount) && d.amount > 0).toBe(true);
        expect(d.description.startsWith("[atlas]")).toBe(false);
      }
      expect(p.bills.length).toBeGreaterThanOrEqual(4);
      expect(p.bills.length).toBeLessThanOrEqual(7);
      for (const b of p.bills) {
        expect(keys(b)).toEqual(["accountKey", "nickname", "payee", "payment_amount", "payment_date", "recurring_date", "status"]);
        expect(b.status).toBe("recurring");
        expect(b.recurring_date).toBeGreaterThanOrEqual(1);
        expect(b.recurring_date).toBeLessThanOrEqual(28);
        expect(b.payment_amount).toBeGreaterThan(0);
        expect(Number(b.payment_date.slice(8))).toBe(b.recurring_date);
      }
      for (const x of p.purchases) {
        expect(keys(x)).toEqual(["accountKey", "amount", "category", "description", "medium", "merchantName", "purchase_date", "status"]);
        expect(x).toMatchObject({ medium: "balance", status: "completed" });
        expect(["checking", "credit"]).toContain(x.accountKey);
        expect(Number.isInteger(x.amount) && x.amount > 0).toBe(true);
        expect(merchants.get(x.merchantName)).toBe(x.category);
      }
      const paychecks = p.deposits.filter((d) => d.description.startsWith("Payroll:"));
      expect(paychecks.length).toBeGreaterThanOrEqual(6);
      expect(paychecks.every((d) => d.accountKey === "checking")).toBe(true);
    }
  });

  it("generates roughly the persona's monthly purchase count", () => {
    for (const persona of PERSONA_IDS) {
      const p = generateProfile({ seedKey: "count", persona, months: 6, asOf: AS_OF });
      const [lo, hi] = PERSONAS[persona].purchasesPerMonth;
      for (const ym of ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]) {
        const n = p.purchases.filter((x) => x.purchase_date.startsWith(ym)).length;
        expect(n).toBeGreaterThanOrEqual(lo);
        expect(n).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("pays on each persona's cadence", () => {
    for (const persona of PERSONA_IDS) {
      for (const seedKey of ["alpha", "bravo", "charlie", "delta"]) {
        for (const months of [6, 12]) {
          const p = generateProfile({ seedKey, persona, months, asOf: AS_OF });
          const paydays = p.deposits.filter((d) => d.description.startsWith("Payroll:")).map((d) => d.transaction_date);
          expect(inferPaycheckCadence(paydays).kind, `${persona}/${seedKey}/${months}`).toBe(PERSONAS[persona].cadence);
        }
      }
    }
    const weekly = generateProfile({ seedKey: "fri", persona: "barista_student", months: 6, asOf: AS_OF });
    const dows = weekly.deposits.filter((d) => d.description.startsWith("Payroll:")).map((d) => new Date(`${d.transaction_date}T00:00:00Z`).getUTCDay());
    expect(new Set(dows)).toEqual(new Set([5]));
  });
});

describe("persona catalog", () => {
  it("defines six distinct personas with 4-7 bills each", () => {
    expect(PERSONA_IDS).toHaveLength(6);
    expect(new Set(PERSONA_IDS.map((p) => PERSONAS[p].label)).size).toBe(6);
    expect(new Set(PERSONA_IDS.map((p) => PERSONAS[p].cadence))).toEqual(new Set(["weekly", "biweekly", "semimonthly", "monthly", "irregular"]));
    for (const p of PERSONA_IDS) {
      expect(PERSONAS[p].bills.length).toBeGreaterThanOrEqual(4);
      expect(PERSONAS[p].bills.length).toBeLessThanOrEqual(7);
      for (const b of PERSONAS[p].bills) expect(Number.isInteger(b.amountCents) && b.day >= 1 && b.day <= 28).toBe(true);
    }
  });

  it("lists about 25 uniquely named synthetic merchants in known categories", () => {
    expect(MERCHANTS.length).toBeGreaterThanOrEqual(20);
    expect(MERCHANTS.length).toBeLessThanOrEqual(30);
    expect(new Set(MERCHANTS.map((m) => m.name)).size).toBe(MERCHANTS.length);
    for (const m of MERCHANTS) expect(CATEGORIES).toContain(m.category);
    for (const c of CATEGORIES) expect(MERCHANTS.some((m) => m.category === c)).toBe(true);
  });

  it("picks a stable persona per seed key and uses all of them", () => {
    expect(pickPersona("+15555550123")).toBe(pickPersona("+15555550123"));
    const seen = new Set(Array.from({ length: 120 }, (_, i) => pickPersona(`person-${i}`)));
    expect(seen).toEqual(new Set(PERSONA_IDS));
    expect(generateProfile({ seedKey: "+15555550123", months: 6, asOf: AS_OF }).persona).toBe(pickPersona("+15555550123"));
  });
});

describe("profileToLedger", () => {
  it("maps a profile onto the budget engine's input with the given account ids", () => {
    const p = generateProfile({ seedKey: "ledger", persona: "big_saver", months: 6, asOf: AS_OF });
    const ids = { checking: "c-1", savings: "s-1", credit: "cc-1" };
    const ledger = profileToLedger(p, ids);
    expect(ledger.accounts).toEqual([
      { id: "c-1", type: "Checking", openingBalanceCents: p.accounts[0]!.balance * 100 },
      { id: "s-1", type: "Savings", openingBalanceCents: p.accounts[1]!.balance * 100 },
      { id: "cc-1", type: "Credit Card", openingBalanceCents: p.accounts[2]!.balance * 100 },
    ]);
    expect(ledger.txns).toHaveLength(p.deposits.length + p.withdrawals.length + p.purchases.length);
    expect(ledger.txns.filter((t) => t.kind === "purchase" && t.accountId === "cc-1").length).toBe(p.purchases.filter((x) => x.accountKey === "credit").length);
    expect(ledger.txns.filter((t) => t.kind === "withdrawal")).toHaveLength(p.withdrawals.length);
    expect(ledger.txns.every((t, i, arr) => i === 0 || arr[i - 1]!.date <= t.date)).toBe(true);
    expect(ledger.bills[0]).toEqual({
      accountId: "c-1",
      payee: p.bills[0]!.payee,
      amountCents: Math.round(p.bills[0]!.payment_amount * 100),
      recurringDay: p.bills[0]!.recurring_date,
      status: "recurring",
      description: p.bills[0]!.nickname,
    });
    expect(ledger.bills.some((b) => b.amountCents % 100 !== 0)).toBe(true);
  });
});
