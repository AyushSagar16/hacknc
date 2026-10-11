import { describe, expect, it } from "vitest";
import { namesPerson, noiseReason, normalizePolarity } from "../../src/profile/extract.ts";

describe("extraction noise filter", () => {
  it("a budget command isn't a budget mood", () => {
    expect(noiseReason("budget_comment", { kind: "flexible" }, "atlas keep my budget private", true)).toBe("budget command");
    expect(noiseReason("budget_comment", { kind: "tight" }, "money's tight this month", true)).toBeNull();
    expect(noiseReason("budget_comment", { kind: "ceiling", amountUsd: 600 }, "set my budget to 600", true)).toBeNull();
  });
  it("asking about food or things to do says nothing about the asker", () => {
    expect(noiseReason("dietary", { need: "vegetarian" }, "any good vegetarian restaurants in asheville?", true)).not.toBeNull();
    expect(noiseReason("activity", { tag: "culture" }, "what are the best things to do there in december?", true)).not.toBeNull();
    // but a statement about yourself, a fact about a friend, or a wish for the group stays
    expect(noiseReason("dietary", { need: "vegetarian" }, "im in DC. also im vegetarian fyi", true)).toBeNull();
    expect(noiseReason("dietary", { need: "vegetarian" }, "any good vegetarian restaurants there? ana is vegetarian", false)).toBeNull();
    expect(noiseReason("activity", { tag: "beach" }, "can we do somewhere with beaches?", true)).toBeNull();
  });
  it("plain facts are stored as positive", () => {
    expect(normalizePolarity("travel_limit", "negative")).toBe("positive");
    expect(normalizePolarity("home_city", "neutral")).toBe("positive");
    expect(normalizePolarity("destination", "negative")).toBe("negative");
  });
});

describe("vetoes, ceilings and third-party facts", () => {
  it("a veto needs refusal language; a reaction isn't one", () => {
    expect(noiseReason("destination", { name: "Miami" }, "lol miami? we said mountains or christmas markets.", true, "negative")).not.toBeNull();
    expect(noiseReason("destination", { name: "Miami" }, "miami?", true, "negative")).not.toBeNull();
    expect(noiseReason("destination", { name: "Gatlinburg" }, "we locked gatlinburg already", true, "negative")).not.toBeNull();
    expect(noiseReason("destination", { name: "Gatlinburg" }, "hmm actually can we do asheville instead?", true, "negative")).not.toBeNull();
    expect(noiseReason("destination", { name: "Cancun" }, "no cancun tho its too pricey", true, "negative")).toBeNull();
    expect(noiseReason("destination", { name: "Miami" }, "miami? no way", true, "negative")).toBeNull();
  });
  it("a budget ceiling needs a number", () => {
    expect(noiseReason("budget_comment", { kind: "ceiling", amountUsd: 500 }, "can you send the updated split", true)).not.toBeNull();
    expect(noiseReason("budget_comment", { kind: "ceiling", amountUsd: 600 }, "i can do 600 max", true)).toBeNull();
  });
  it("a fact about a friend needs the friend's name in the message", () => {
    expect(namesPerson("any good vegetarian restaurants there? ana is vegetarian", "ana")).toBe(true);
    expect(namesPerson("ana's vegan btw", "ana")).toBe(true);
    expect(namesPerson("any good vegetarian restaurants there? ana is vegetarian", "carmen")).toBe(false);
    expect(namesPerson("banana bread", "ana")).toBe(false);
  });
});

describe("same-dates references", () => {
  it("resolves date references but not money comparisons", async () => {
    const { sameDatesRef } = await import("../../src/profile/extract.ts");
    expect(sameDatesRef("pittsburgh, same dates")).not.toBeNull();
    expect(sameDatesRef("same as ana")?.[1]).toBe("ana");
    expect(sameDatesRef("why is my share the same as ana's? i'm driving")).toBeNull();
    expect(sameDatesRef("i can only do march 7-14 same as everyone fyi")).not.toBeNull();
  });
});
