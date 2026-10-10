import { describe, expect, it } from "vitest";
import { Figures } from "../../src/agent/figures.ts";
import { guardBubbles, toBubbles } from "../../src/agent/agent.ts";

const figures = () => {
  const f = new Figures();
  f.add({ cents: 55_500, label: "savannah per person", source: "estimate:catalog", visibility: "public" });
  f.add({ cents: 37_500, label: "maya's budget", source: "nessie:cust-1", visibility: "public", ownerId: 1 });
  f.add({ cents: 15_000, label: "leo's budget", source: "nessie:cust-2", visibility: "private", ownerId: 2 });
  return f;
};

describe("money guard", () => {
  it("passes text whose figures are all registered", () => {
    expect(figures().check("savannah's about $555 each, and maya's at $375", { isGroup: true }).ok).toBe(true);
  });

  it("allows rounding on rounded mentions", () => {
    expect(figures().check("roughly $550 per person", { isGroup: true }).ok).toBe(true);
  });

  it("flags made-up figures", () => {
    const r = figures().check("flights are like $300", { isGroup: true });
    expect(r.ok).toBe(false);
    expect(r.unknown.map((m) => m.raw)).toEqual(["$300"]);
  });

  it("flags a private figure in a group, allows it in its owner's DM", () => {
    expect(figures().check("leo can do $150", { isGroup: true }).privateLeaks).toHaveLength(1);
    expect(figures().check("you can do $150", { isGroup: false, viewerId: 2 }).ok).toBe(true);
    expect(figures().check("you can do $150", { isGroup: false, viewerId: 1 }).ok).toBe(false);
  });

  it("ignores numbers that aren't money (dates, counts)", () => {
    expect(figures().check("nov 12–16, 3 of you, 4 nights", { isGroup: true }).ok).toBe(true);
  });

  it("guardBubbles drops all model bubbles when any figure fails", () => {
    expect(guardBubbles(["sounds good", "it's $999"], figures(), { isGroup: true })).toEqual({ bubbles: [], violations: ["unregistered figure $999"] });
  });

  it("toBubbles strips NO_REPLY, markdown and splits on blank lines (max 3)", () => {
    expect(toBubbles("NO_REPLY", "Atlas")).toEqual([]);
    expect(toBubbles("**hey**\n\nsecond\n\nthird\n\nfourth", "Atlas")).toEqual(["hey", "second", "third"]);
    expect(toBubbles("atlas: hi", "Atlas")).toEqual(["hi"]);
  });

  it("toBubbles drops tool calls a small model wrote as text", () => {
    const tools = ["ask_for_missing_info", "show_budgets"];
    expect(toBubbles("drop your dates and home cities below so i can line them up.setDefaultApi:ask_for_missing_info{}", "Atlas", tools)).toEqual([
      "drop your dates and home cities below so i can line them up.",
    ]);
    expect(toBubbles("default_api.show_budgets()", "Atlas", tools)).toEqual([]);
    expect(toBubbles("here you go\n\n```tool_code\nshow_budgets({})\n```", "Atlas", tools)).toEqual(["here you go"]);
    expect(toBubbles("got those, maya. where are you flying from?\n<call:></call:default_api>", "Atlas", tools)).toEqual([
      "got those, maya. where are you flying from?",
    ]);
    // Mentioning a tool-like word in prose is fine.
    expect(toBubbles("want me to show budgets?", "Atlas", tools)).toEqual(["want me to show budgets?"]);
  });
});
