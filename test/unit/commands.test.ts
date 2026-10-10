import { describe, expect, it } from "vitest";
import { parseCommand } from "../../src/agent/commands.ts";

describe("parseCommand", () => {
  it.each([
    ["atlas stay quiet", true, "quiet"],
    ["atlas shh", true, "quiet"],
    ["atlas you can talk again", true, "unquiet"],
    ["atlas summarize", true, "summarize"],
    ["atlas where are we", true, "summarize"],
    ["atlas help", true, "help"],
    ["what's our budget", false, "budget_query"],
    ["keep my budget private", false, "budget_private"],
    ["make my budget public", false, "budget_public"],
    ["let's settle up", false, "settle_up"],
    ["atlas who owes who", true, "balances"],
    ["atlas give us some options", true, "propose"],
  ])("%s → %s", (text, addressed, kind) => {
    expect(parseCommand(text, { addressed })?.kind).toBe(kind);
  });

  it("parses budget amounts, including k", () => {
    expect(parseCommand("set my budget to 600", { addressed: false })).toEqual({ kind: "budget_set", amountCents: 60_000 });
    expect(parseCommand("my budget is $1,250", { addressed: false })).toEqual({ kind: "budget_set", amountCents: 125_000 });
    expect(parseCommand("set my budget to 1.2k", { addressed: false })).toEqual({ kind: "budget_set", amountCents: 120_000 });
  });

  it("friend-to-friend phrasing isn't a command unless Atlas is addressed", () => {
    expect(parseCommand("leo stay quiet lol", { addressed: false })).toBeNull();
    expect(parseCommand("can you help me with my bag", { addressed: false })).toBeNull();
    expect(parseCommand("atlas can you help with flights?", { addressed: true })).toBeNull();
  });
});
