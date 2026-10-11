import { describe, expect, it } from "vitest";
import { parseExpense } from "../../src/trips/expenseParse.ts";

const MEMBERS = ["Maya", "Leo", "Priya", "Jordan"];
const parse = (text: string) => parseExpense(text, MEMBERS);

describe("parseExpense", () => {
  it.each([
    ["i paid 64 for dinner", 6_400, "dinner"],
    ["paid $120.50 for the airbnb deposit", 12_050, "airbnb deposit"],
    ["i covered gas $45", 4_500, "gas"],
    ["just paid 38 for uber", 3_800, "uber"],
    ["i got dinner, it was 64", 6_400, "dinner"],
    ["I paid $1,240 for the Airbnb.", 124_000, "Airbnb"],
    ["i spent 45 on gas", 4_500, "gas"],
    ["i paid 64 bucks for dinner", 6_400, "dinner"],
    ["i paid 1.2k for the airbnb", 120_000, "airbnb"],
    ["paid for groceries, $82.17", 8_217, "groceries"],
    ["i bought the ferry tickets for $30", 3_000, "ferry tickets"],
    ["i paid 30 for a day pass", 3_000, "day pass"],
    ["i covered the parking ($12)", 1_200, "parking"],
    ["@atlas i paid 64 for dinner!! 🍝", 6_400, "dinner"],
    ["ok so i already paid 38 for the uber lol", 3_800, "uber"],
  ])("reads %j", (text, amountCents, description) => {
    expect(parse(text)).toEqual({ amountCents, description, splitAmong: null, confidence: "high" });
  });

  it("reads who shared it", () => {
    expect(parse("i paid 30 for me and maya's tickets")).toEqual({
      amountCents: 3_000,
      description: "tickets",
      splitAmong: ["me", "Maya"],
      confidence: "high",
    });
    expect(parse("i paid 90 for the boat, split with leo and priya")).toEqual({
      amountCents: 9_000,
      description: "boat",
      splitAmong: ["me", "Leo", "Priya"],
      confidence: "high",
    });
    expect(parse("i paid 60 for dinner, split between Leo and Priya")?.splitAmong).toEqual(["Leo", "Priya"]);
    expect(parse("i paid 60 for dinner with leo")?.splitAmong).toEqual(["me", "Leo"]);
    expect(parse("i paid 60 for dinner for leo, priya and me")?.splitAmong).toEqual(["Leo", "Priya", "me"]);
    expect(parse("i paid 40 for leo's ticket")).toMatchObject({ description: "ticket", splitAmong: ["Leo"] });
    expect(parse("i covered gas $45, split with jordan")?.splitAmong).toEqual(["me", "Jordan"]);
    expect(parse("i covered maya and leo's tickets $30")).toMatchObject({
      description: "tickets",
      splitAmong: ["Maya", "Leo"],
    });
    expect(parse("i paid 64 for dinner with the team")).toMatchObject({ description: "dinner with the team", splitAmong: null });
  });

  it("treats the whole group as everyone", () => {
    expect(parse("i paid 64 for dinner for everyone")?.splitAmong).toBeNull();
    expect(parse("i paid 64 for dinner, split evenly")).toMatchObject({ description: "dinner", splitAmong: null });
    expect(parse("i paid 64 for dinner, split with the group")?.splitAmong).toBeNull();
  });

  it("is less sure without a description, with a rough amount, or for a personal cost", () => {
    expect(parse("i paid 64")).toEqual({ amountCents: 6_400, description: "", splitAmong: null, confidence: "low" });
    expect(parse("i paid like 64 for dinner")).toMatchObject({ amountCents: 6_400, confidence: "low" });
    expect(parse("i paid 30 for me and maya")).toMatchObject({ description: "", splitAmong: ["me", "Maya"], confidence: "low" });
    expect(parse("i paid 20 for my uber")).toMatchObject({ description: "uber", splitAmong: ["me"], confidence: "low" });
  });

  it.each([
    // questions and plans
    "should i pay 64?",
    "i paid 64 for dinner?",
    "can someone cover 64 for dinner",
    "i'll pay 64 for dinner",
    "i'm gonna pay 64 for dinner",
    "i didn't pay 64 for dinner",
    // prices being discussed
    "dinner is 64 per person",
    "tickets are $30",
    "i paid 30 each for tickets",
    "i paid 200 a night for the airbnb",
    "i paid $30/person for the boat",
    // someone else paying, or paying someone back
    "maya paid 40",
    "leo covered gas $45",
    "we paid 90 for the boat",
    "i paid maya 40",
    "i paid you 40",
    "i paid leo back 20",
    "i owe maya 40",
    "i paid maya for leo's ticket 40",
    "i paid 64 for dinner and maya paid for drinks",
    "i paid $45 for gas, leo owes me half",
    // more than one figure
    "i paid 40 for dinner and 20 for drinks",
    "i paid 30 for 2 tickets",
    "i paid 64 for dinner on the 14th",
    // refunds
    "i got refunded 40 for the tickets",
    "i got reimbursed $40",
    // people we don't know, or conflicting splits
    "i paid 30 for bob's ticket",
    "i paid 90 for the boat, split with leo and bob",
    "i paid 30 for leo's ticket, split with maya",
    // not money
    "i paid for dinner",
    "i paid 0 for dinner",
    "i paid 10.005 for gum",
    "",
    // too long to be a clean statement
    `i paid 64 for ${"a really long ".repeat(25)}dinner`,
  ])("returns null for %j", (text) => {
    expect(parse(text)).toBeNull();
  });
});

describe("buying for someone else", () => {
  it.each([
    ["i got leo's ticket, $40", 4_000, "ticket", ["Leo"]],
    ["bought dinner for priya 30", 3_000, "dinner", ["Priya"]],
    ["i bought priya dinner, 30", 3_000, "dinner", ["Priya"]],
    ["i got leo a ticket for 40", 4_000, "ticket", ["Leo"]],
    ["got leo and priya lunch, 36", 3_600, "lunch", ["Leo", "Priya"]],
    ["grabbed jordan's coffee $6", 600, "coffee", ["Jordan"]],
  ] as const)("%j is all on them", (text, cents, description, who) => {
    expect(parse(text)).toEqual({ amountCents: cents, description, splitAmong: [...who], confidence: "high" });
  });

  it.each(["i paid leo 40", "i got leo back 20", "i got leo 40", "put the boat rental on the fund, it's 240"])("paying someone back is not buying for them: %j", (text) => {
    expect(parse(text)).toBeNull();
  });
});
