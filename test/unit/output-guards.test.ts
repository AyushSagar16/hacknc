import { describe, expect, it } from "vitest";
import { dropUnknownLinks, runAgent, EMPTY_NUDGE } from "../../src/agent/agent.ts";
import { Figures } from "../../src/agent/figures.ts";
import { LlmError } from "../../src/agent/llm.ts";

describe("link guard", () => {
  it("drops an invented link and keeps real ones", () => {
    const known = ["trip page: https://planwithatlas.tech/t/abc-123"];
    expect(dropUnknownLinks(["here you go https://capitalone.com/trips/orlando-oct-2026"], known)).toEqual({
      bubbles: [],
      dropped: ["https://capitalone.com/trips/orlando-oct-2026"],
    });
    expect(dropUnknownLinks(["locked in. see https://planwithatlas.tech/t/abc-123"], known).bubbles).toEqual(["locked in. see https://planwithatlas.tech/t/abc-123"]);
  });
  it("drops a site url with a wrong id", () => {
    const r = dropUnknownLinks(["locked in.", "trip page: https://planwithatlas.tech/t/made-up"], ["https://planwithatlas.tech/t/abc-123"]);
    expect(r.bubbles).toEqual(["locked in."]);
  });
  it("keeps the rest of the bubble and accepts urls from tool results", () => {
    const r = dropUnknownLinks(["fun spot. capitalone.com/x is great."], []);
    expect(r.bubbles).toEqual(["fun spot."]);
    expect(dropUnknownLinks(["menu at https://x.example.com/menu"], ['{"website":"https:\\/\\/x.example.com\\/menu"}']).dropped).toEqual([]);
  });
  it("leaves link-free text alone", () => {
    expect(dropUnknownLinks(["see you at 3.5 stars, e.g. fine"], []).bubbles).toEqual(["see you at 3.5 stars, e.g. fine"]);
  });
});

describe("money guard without a dollar sign", () => {
  const f = new Figures();
  f.add({ cents: 14_000, label: "tickets", source: "estimate:x", visibility: "public" });
  const check = (t: string) => f.check(t, { isGroup: true });
  it("flags prices from memory", () => {
    expect(check("universal orlando tickets are on their official site, about 115 to 150 depending on the day.").ok).toBe(false);
    expect(check("it's 150 bucks").ok).toBe(false);
    expect(check("rooms are around 200 a night").ok).toBe(false);
    expect(check("200 dollars each").ok).toBe(false);
    expect(check("tickets cost 90 per person").ok).toBe(false);
  });
  it("passes registered figures", () => {
    expect(check("tickets cost about 140 per person").ok).toBe(true);
  });
  it("ignores dates, times, counts and ratings", () => {
    for (const t of ["tickets for oct 12 are booked", "4 tickets, 3 nights, 2026", "the park opens at 10 am, tickets in hand", "rated 4.5 stars, price is fair", "we're 12 people so tickets are a lot", "flight 1234 is cheap"])
      expect(check(t).ok, t).toBe(true);
  });
});

describe("empty model answer", () => {
  it("nudges once when generate throws kind empty", async () => {
    const calls: unknown[] = [];
    const llm = {
      generate: async (req: { contents: unknown[] }) => {
        calls.push(JSON.stringify(req.contents));
        if (calls.length === 1) throw new LlmError("gemini returned nothing (STOP)", "empty");
        return { text: "hey there", functionCalls: [], parts: [{ text: "hey there" }] };
      },
    };
    const tools = { declsFor: () => [], isSolo: () => false, run: async () => ({ ok: true }) };
    const out = await runAgent({
      llm: llm as never,
      model: "m",
      situation: "hi",
      tools: tools as never,
      ctx: { chat: { id: 1 }, turnId: 1, out: [] } as never,
      signal: new AbortController().signal,
      agentName: "Atlas",
    });
    expect(out.failed).toBeUndefined();
    expect(out.bubbles).toEqual(["hey there"]);
    expect(out.retried).toBe(true);
    expect(String(calls[1])).toContain(EMPTY_NUDGE.slice(0, 20));
  });
});
