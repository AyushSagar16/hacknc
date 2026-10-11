import { describe, expect, it } from "vitest";
import { dropPromises, dropTailOffer, promisesAction } from "../../src/agent/agent.ts";
import { asksForAnswer, repeatsRecent } from "../../src/agent/brain.ts";
import { gateFallback, roomNeedsAtlas } from "../../src/agent/speakGate.ts";

const names = ["ana", "luis", "carmen", "maya", "dev"];

describe("promises", () => {
  it("catches an action announced without a tool call", () => {
    expect(promisesAction("got it, let me look for beach spots under 800.", false)).toBe(true);
    expect(promisesAction("one sec, pulling options", false)).toBe(true);
    expect(promisesAction("let me know which one you like", false)).toBe(false);
    expect(promisesAction("asheville has highs around 50", false)).toBe(false);
  });
  it("a promise to follow up later is never true, even after a tool ran", () => {
    expect(promisesAction("search timed out, i'll keep trying and let you know", true)).toBe(true);
    expect(promisesAction("let me know if that works", true)).toBe(false);
  });
  it("drops just the promise sentence", () => {
    expect(dropPromises("search timed out on me. i'll keep trying and let you know.", true)).toBe("search timed out on me.");
    expect(dropPromises("got it, let me look for beach spots under 800.", false)).toBe("");
  });
});

describe("tail offers", () => {
  it("drops a generic offer at the end", () => {
    expect(dropTailOffer(["pack warm layers and boots.", "anything else you want to check before we head out?"])).toEqual(["pack warm layers and boots."]);
    expect(dropTailOffer(["laughing seed is great. want me to look for a few more or is that enough to start?"])).toEqual(["laughing seed is great."]);
  });
  it("keeps a question that unblocks the plan", () => {
    expect(dropTailOffer(["overlap is mar 9–14, that work?"])).toEqual(["overlap is mar 9–14, that work?"]);
    expect(dropTailOffer(["maya, which dates work for you?"])).toEqual(["maya, which dates work for you?"]);
  });
});

describe("room questions that must reach Atlas", () => {
  it.each([
    "what's the typical high and low temp in december there tho",
    "how is the split calculated?",
    "honestly that's too expensive for me",
    "hmm actually can we do asheville instead? i think the christmas lights and breweries there are better",
    "and does either have good vegan food?",
  ])("%s → speak", (t) => expect(roomNeedsAtlas(t, names)).not.toBeNull());
  it.each(["lol", "maya do u have a car or are we flying", "did anyone watch the game last night", "anyone want pizza", "lol carmen you're gonna hate the cold", "so who's actually hot in this chat", "dev, are you in?"])("%s → not forced", (t) =>
    expect(roomNeedsAtlas(t, names)).toBeNull(),
  );
  it("the gate fallback speaks on trip details but not on banter", () => {
    expect(gateFallback({ newest: [{ label: "Ben", text: "i'm in chicago, jan 24-28 fine" }], memberNames: names })).toMatch(/ben shared trip details/);
    expect(gateFallback({ newest: [{ label: "Jay", text: "ben ur so dumb" }], memberNames: names })).toBeNull();
  });
});

describe("repeats and tool questions", () => {
  const history = [{ direction: "outbound" as const, text: "sol and ravi, cast your votes in the poll above to break the tie between denver and san juan." }];
  it("a near-identical nudge counts as a repeat", () => {
    expect(repeatsRecent("sol and ravi, drop your votes in the poll above so we can break the tie between denver and san juan.", history)).toBe(true);
    expect(repeatsRecent("denver won 3 of 5, locked in for jan 24–28. payment plan is up next", history)).toBe(false);
  });
  it("knows when a tool post waits on an answer", () => {
    expect(asksForAnswer('omar, nina wants to make it $54.00 for #2 (gas, $64.00). reply "yes" to fix it or "no" to keep it')).toBe(true);
    expect(asksForAnswer("logged #1: dinner $90.00")).toBe(false);
  });
});

describe("claims about unknown dates or cities", () => {
  const known = [
    { name: "jay", dates: true, city: true },
    { name: "ravi", dates: false, city: true },
  ];
  it("cuts a sentence that says ravi's dates are set when they aren't known", async () => {
    const { dropUnknownClaims } = await import("../../src/agent/agent.ts");
    const out = dropUnknownClaims("we've got jan 24 to 28 for jay. ravi's dates are set too.\n\nlet's look at spots", known);
    expect(out.text).toBe("we've got jan 24 to 28 for jay.\n\nlet's look at spots");
    expect(out.dropped).toEqual(["ravi's dates are set too."]);
  });
  it("leaves questions and mentions of what's missing alone", async () => {
    const { dropUnknownClaims } = await import("../../src/agent/agent.ts");
    expect(dropUnknownClaims("ravi, what dates work for you?", known).dropped).toEqual([]);
    expect(dropUnknownClaims("still need ravi's dates", known).dropped).toEqual([]);
  });
});
