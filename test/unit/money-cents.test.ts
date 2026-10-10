import { describe, expect, it } from "vitest";
import { MoneyError, formatUsd, parseMoneyMentions, toCents } from "../../src/money/cents.ts";

describe("toCents", () => {
  it.each([
    [64, 6400],
    [64.5, 6450],
    [0.1, 10],
    [0.29, 29],
    [1.15, 115],
    ["64", 6400],
    ["$1,240.50", 124050],
    ["1240.5", 124050],
    [" $12 ", 1200],
    ["$ 12", 1200],
    ["0.05", 5],
    [".5", 50],
    ["12.", 1200],
    ["1,000,000", 100000000],
    [0, 0],
  ] as const)("reads %j as %i cents", (input, cents) => {
    expect(toCents(input)).toBe(cents);
  });

  it("is exact where float math is not", () => {
    // 1.15 * 100 === 114.99999999999999 and 0.29 * 100 === 28.999999999999996
    expect(toCents(1.15)).toBe(115);
    expect(toCents("19.99")).toBe(1999);
    expect(toCents(4.35)).toBe(435);
  });

  it.each([NaN, Infinity, -Infinity, "", "   ", "$", ".", "abc", "12abc", "1,2345", "1,24", "--5", 1e21, 1e-7])(
    "rejects %j",
    (input) => {
      expect(() => toCents(input)).toThrow(MoneyError);
    },
  );

  it("rejects sub-cent precision", () => {
    expect(() => toCents(10.005)).toThrow(/decimal places/);
    expect(() => toCents("10.005")).toThrow(MoneyError);
    expect(() => toCents(0.1 + 0.2)).toThrow(MoneyError);
  });

  it("allows negatives only when asked", () => {
    expect(() => toCents(-5)).toThrow(MoneyError);
    expect(() => toCents("-$1.95")).toThrow(MoneyError);
    expect(toCents(-5, { allowNegative: true })).toBe(-500);
    expect(toCents("-$1.95", { allowNegative: true })).toBe(-195);
    expect(toCents("$-1.95", { allowNegative: true })).toBe(-195);
    expect(Object.is(toCents("-0"), 0)).toBe(true);
  });

  it("rejects amounts too large to hold exactly", () => {
    expect(() => toCents("99999999999999999")).toThrow(MoneyError);
  });
});

describe("formatUsd", () => {
  // Ported from scout tests/test_money.py
  it("whole dollars have no cents", () => {
    expect(formatUsd(124_000)).toBe("$1,240");
  });

  it("partial dollars show both cent digits", () => {
    expect(formatUsd(23_650)).toBe("$236.50");
    expect(formatUsd(5)).toBe("$0.05");
  });

  it("puts the sign before the dollar sign", () => {
    expect(formatUsd(-195)).toBe("-$1.95");
    expect(formatUsd(-5)).toBe("-$0.05");
    expect(formatUsd(-124_000)).toBe("-$1,240");
  });

  it("can always show cents", () => {
    expect(formatUsd(124_000, { cents: "always" })).toBe("$1,240.00");
    expect(formatUsd(0, { cents: "always" })).toBe("$0.00");
    expect(formatUsd(124_000, { cents: "auto" })).toBe("$1,240");
  });

  it("groups thousands", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(99_999)).toBe("$999.99");
    expect(formatUsd(100_000_000)).toBe("$1,000,000");
    expect(formatUsd(Number.MAX_SAFE_INTEGER)).toBe("$90,071,992,547,409.91");
  });

  it("refuses anything that isn't whole cents", () => {
    expect(() => formatUsd(1.5)).toThrow(MoneyError);
    expect(() => formatUsd(NaN)).toThrow(MoneyError);
  });

  it("round-trips through toCents", () => {
    for (const cents of [0, 1, 5, 99, 100, 101, 12_345, 124_050, 98_765_432]) {
      expect(toCents(formatUsd(cents))).toBe(cents);
    }
  });
});

describe("parseMoneyMentions", () => {
  const cents = (text: string) => parseMoneyMentions(text).map((m) => m.cents);

  it.each([
    ["$1,200", 120_000],
    ["$64", 6_400],
    ["64 bucks", 6_400],
    ["1.2k", 120_000],
    ["$1.2k", 120_000],
    ["2K", 200_000],
    ["600 dollars", 60_000],
    ["64.50", 6_450],
    ["$64.50", 6_450],
    ["$ 20", 2_000],
    ["50 usd", 5_000],
    ["2 grand", 200_000],
    ["$1.5m", 150_000_000],
  ] as const)("finds %j", (text, expected) => {
    expect(cents(text)).toEqual([expected]);
  });

  it("splits a range into both figures", () => {
    expect(parseMoneyMentions("$40-60")).toEqual([
      { cents: 4_000, raw: "$40", index: 0 },
      { cents: 6_000, raw: "60", index: 4 },
    ]);
    expect(cents("$40 - $60")).toEqual([4_000, 6_000]);
    expect(cents("40–60 bucks")).toEqual([4_000, 6_000]);
    expect(cents("1-2k")).toEqual([100_000, 200_000]);
    expect(cents("$500-1k")).toEqual([50_000, 100_000]);
  });

  it("ignores bare numbers that aren't money", () => {
    expect(cents("see you on the 14th")).toEqual([]);
    expect(cents("meet at 7pm, 3 people, 2 nights")).toEqual([]);
    expect(cents("flight lands at 7.30 pm")).toEqual([]);
    expect(cents("call 555-1234")).toEqual([]);
    expect(cents("we're doing 2026")).toEqual([]);
    expect(cents("rated 4.50 stars, 5km away, 4.25%")).toEqual([]);
    expect(cents("pi is 3.14159")).toEqual([]);
    expect(cents("we have 64 kids")).toEqual([]);
  });

  it("skips figures it can't read exactly", () => {
    expect(cents("$1,2345")).toEqual([]);
    expect(cents("$10.005")).toEqual([]);
  });

  it("returns every figure in order with where it was", () => {
    const text = "airbnb is $1,240.50 total, so about 310 bucks each. dinner $64.";
    expect(parseMoneyMentions(text)).toEqual([
      { cents: 124_050, raw: "$1,240.50", index: 10 },
      { cents: 31_000, raw: "310 bucks", index: 36 },
      { cents: 6_400, raw: "$64", index: 59 },
    ]);
    for (const m of parseMoneyMentions(text)) expect(text.slice(m.index, m.index + m.raw.length)).toBe(m.raw);
  });

  it("handles punctuation right after a figure", () => {
    expect(cents("$64, $80, and $100.")).toEqual([6_400, 8_000, 10_000]);
    expect(cents("($45)")).toEqual([4_500]);
  });
});
