import { describe, expect, it } from "vitest";
import { combinedSettle, FUND, fundShares, proRata } from "../../src/money/fund.ts";
import { balances } from "../../src/money/settle.ts";
import { depositDeadline, fundName } from "../../src/trips/fund.ts";

const MAYA = 1;
const LEO = 2;
const PRIYA = 3;
const all = [MAYA, LEO, PRIYA];
const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const map = (entries: [number, number][]) => new Map(entries);

describe("fund shares", () => {
  it("splits the stay equally to the cent, odd cents to the earliest members", () => {
    const shares = fundShares([{ amountCents: 124_000 }], all);
    expect([...shares.values()]).toEqual([41_334, 41_333, 41_333]);
    expect(sum(shares)).toBe(124_000);
  });

  it("by cost: an item only some of the group wanted is only on them", () => {
    const shares = fundShares([{ amountCents: 90_000 }, { amountCents: 24_000, sharedBy: [MAYA, LEO] }], all, "by_cost");
    expect(shares.get(MAYA)).toBe(42_000);
    expect(shares.get(LEO)).toBe(42_000);
    expect(shares.get(PRIYA)).toBe(30_000);
  });

  it("even: one equal share of the whole target, whoever each item was for", () => {
    const shares = fundShares([{ amountCents: 90_000 }, { amountCents: 24_000, sharedBy: [MAYA, LEO] }], all, "even");
    expect([...shares.values()]).toEqual([38_000, 38_000, 38_000]);
  });

  it("someone listed on an item who isn't in the group falls back to the people who are", () => {
    expect(sum(fundShares([{ amountCents: 1_001, sharedBy: [99] }], all))).toBe(1_001);
  });
});

describe("pro-rata refunds", () => {
  it("divides the leftover by what each put in, to the cent", () => {
    const r = proRata(10_000, map([[MAYA, 30_000], [LEO, 30_000], [PRIYA, 15_000]]));
    expect(r.get(MAYA)).toBe(4_000);
    expect(r.get(LEO)).toBe(4_000);
    expect(r.get(PRIYA)).toBe(2_000);
    expect(sum(proRata(10_001, map([[MAYA, 1], [LEO, 1], [PRIYA, 1]])))).toBe(10_001);
  });

  it("nobody who put nothing in gets anything back", () => {
    expect(proRata(500, map([[MAYA, 100], [LEO, 0]])).get(LEO)).toBe(0);
  });
});

describe("combined settle-up", () => {
  const noTab = map(all.map((id) => [id, 0]));

  it("a fully funded, fully spent fund and an even tab: nothing to send", () => {
    const r = combinedSettle({ members: all, contributed: map([[MAYA, 41_334], [LEO, 41_333], [PRIYA, 41_333]]), refunded: new Map(), spendShares: fundShares([{ amountCents: 124_000 }], all), tab: noTab });
    expect(r.transfers).toEqual([]);
    expect(r.leftoverCents).toBe(0);
    expect(r.shortfallCents).toBe(0);
  });

  it("a leftover goes back pro-rata first, then the tab settles between people", () => {
    // The fund collected 1,500 but the stay cost 1,200: 300 left. Maya paid 90 for dinner for all three.
    const contributed = map([[MAYA, 50_000], [LEO, 50_000], [PRIYA, 50_000]]);
    const tab = balances(all, [{ payer: MAYA, shares: map([[MAYA, 3_000], [LEO, 3_000], [PRIYA, 3_000]]) }], []);
    const r = combinedSettle({ members: all, contributed, refunded: new Map(), spendShares: fundShares([{ amountCents: 120_000 }], all), tab });
    expect(r.leftoverCents).toBe(30_000);
    expect([...r.refunds]).toEqual([[MAYA, 10_000], [LEO, 10_000], [PRIYA, 10_000]]);
    expect(r.shortfallCents).toBe(0);
    expect(r.transfers).toEqual([
      { from: LEO, to: MAYA, amountCents: 3_000 },
      { from: PRIYA, to: MAYA, amountCents: 3_000 },
    ]);
  });

  it("a refund already paid isn't paid again", () => {
    const r = combinedSettle({ members: all, contributed: map([[MAYA, 50_000], [LEO, 50_000], [PRIYA, 50_000]]), refunded: map([[MAYA, 10_000], [LEO, 10_000], [PRIYA, 10_000]]), spendShares: fundShares([{ amountCents: 120_000 }], all), tab: noTab });
    expect(r.refunds.size).toBe(0);
    expect(r.transfers).toEqual([]);
  });

  it("a shortfall makes the fund a creditor, netted against the tab", () => {
    // Everyone put in 413.33 for the stay; then a 240 boat went on the fund: 80 short each.
    // Maya is owed 60 on the tab, Leo owes 70 (30 dinner + priya's 40 ticket), Priya is owed 10.
    const contributed = map([[MAYA, 41_334], [LEO, 41_333], [PRIYA, 41_333]]);
    const spendShares = fundShares([{ amountCents: 124_000 }, { amountCents: 24_000 }], all);
    const tab = map([[MAYA, 6_000], [LEO, -7_000], [PRIYA, 1_000]]);
    const r = combinedSettle({ members: all, contributed, refunded: new Map(), spendShares, tab });
    expect(r.shortfallCents).toBe(24_000);
    expect(r.refunds.size).toBe(0);
    expect(r.transfers).toEqual([
      { from: MAYA, to: FUND, amountCents: 2_000 },
      { from: LEO, to: FUND, amountCents: 15_000 },
      { from: PRIYA, to: FUND, amountCents: 7_000 },
    ]);
    expect(r.transfers.reduce((a, t) => a + t.amountCents, 0)).toBe(24_000);
  });

  it("someone who put in more covers someone who put in nothing (never connected a bank)", () => {
    const contributed = map([[MAYA, 60_000], [LEO, 60_000]]);
    const r = combinedSettle({ members: all, contributed, refunded: new Map(), spendShares: fundShares([{ amountCents: 120_000 }], all), tab: noTab });
    expect(r.shortfallCents).toBe(0);
    expect(r.transfers).toEqual([
      { from: PRIYA, to: MAYA, amountCents: 20_000 },
      { from: PRIYA, to: LEO, amountCents: 20_000 },
    ]);
  });

  it("someone who left after paying in gets their money back through the list", () => {
    const r = combinedSettle({ members: [MAYA, LEO], contributed: map([[MAYA, 30_000], [LEO, 30_000], [PRIYA, 30_000]]), refunded: new Map(), spendShares: fundShares([{ amountCents: 90_000 }], [MAYA, LEO]), tab: map([[MAYA, 0], [LEO, 0]]) });
    expect(r.transfers).toEqual([
      { from: MAYA, to: PRIYA, amountCents: 15_000 },
      { from: LEO, to: PRIYA, amountCents: 15_000 },
    ]);
  });

  it("everyone's nets plus the fund always sum to zero", () => {
    const r = combinedSettle({ members: all, contributed: map([[MAYA, 12_345], [LEO, 67_891]]), refunded: map([[LEO, 1_111]]), spendShares: fundShares([{ amountCents: 77_777 }], all), tab: map([[MAYA, 501], [LEO, -1_002], [PRIYA, 501]]) });
    expect(sum(r.net) + r.shortfallCents).toBe(0);
  });
});

describe("fund basics", () => {
  it("the deposit deadline is two weeks before the trip, never today or earlier", () => {
    expect(depositDeadline("2026-12-10", "2026-10-10")).toBe("2026-11-26");
    expect(depositDeadline("2026-10-20", "2026-10-10")).toBe("2026-10-11");
  });

  it("names the fund after the trip", () => {
    expect(fundName({ title: null, destination_name: "Charleston" })).toBe("Charleston Trip Fund");
    expect(fundName({ title: "tahoe trip", destination_name: "Lake Tahoe" })).toBe("Tahoe Trip Fund");
    expect(fundName({ title: null, destination_name: "Boone, NC" })).toBe("Boone Trip Fund");
  });
});
