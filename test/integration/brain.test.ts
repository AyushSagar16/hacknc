import { afterEach, describe, expect, it } from "vitest";
import { q } from "../../src/db/pool.ts";
import { callResult, FakeLlm, jsonResult, textResult, type GenerateRequest } from "../../src/agent/llm.ts";
import { OffsetClock, setClock, systemClock } from "../../src/clock.ts";
import { dbAvailable } from "../helpers/db.ts";
import { pastIntro, quietFake, testAtlas, type TestAtlas } from "../helpers/atlas.ts";

const describeDb = dbAvailable ? describe : describe.skip;

describeDb("brain", () => {
  let t: TestAtlas | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it("introduces itself once when added, then stays quiet through banter", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("g1", ["maya", "leo", "priya"]);
    const intro = await chat.addAtlas("maya");
    expect(intro).toHaveLength(3);
    expect(intro[0]!.text).toMatch(/^hi, i'm atlas, your trip and financial planner/);
    expect(intro[1]!.text).toContain("demo spending profiles");
    // Right after the intro's question, a message may be an answer: the agent decides (NO_REPLY here).
    expect(await chat.say("leo", "lol did you see the game")).toEqual([]);
    expect(llm.calls.filter((c) => c.role === "agent")).toHaveLength(1);
    for (const text of ["haha yes", "insane", "that game was wild"]) expect(await chat.say("priya", text)).toEqual([]);
    const gateCalls = llm.calls.filter((c) => c.role === "gate").length;
    expect(gateCalls).toBeGreaterThanOrEqual(1);
    // Pure laughter costs no model calls at all.
    const before = llm.calls.length;
    expect(await chat.say("leo", "lmaooo 😂")).toEqual([]);
    expect(llm.calls.length).toBe(before);
    // A second join event never repeats the intro.
    expect(await chat.addMember("sam", "+15550109999")).toHaveLength(1);
  });

  it("answers when tagged without asking the gate", async () => {
    const llm = quietFake().set("agent", () => textResult("somewhere warm sounds right. what dates work?"));
    t = await testAtlas({ llm });
    const chat = t.chat("g2", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    const replies = await chat.say("maya", "hey atlas where should we go in november");
    expect(replies.map((r) => r.text)).toEqual(["somewhere warm sounds right. what dates work?"]);
    expect(llm.calls.filter((c) => c.role === "gate")).toHaveLength(0);
    const agentCall = llm.calls.find((c) => c.role === "agent")!;
    const situation = (agentCall.contents[0]!.parts[0] as { text: string }).text;
    expect(situation).toContain("[Maya] hey atlas where should we go in november (tags or replies to you)");
  });

  it("speaks untagged only when the gate says so, in one bubble", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("g3", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    llm.set("gate", () => jsonResult({ decision: "SPEAK", reason: "trip question to the room" }));
    llm.set("agent", () => textResult("flights are usually cheaper midweek\n\nwant me to pull options?"));
    const replies = await chat.say("leo", "anyone know if flights are cheaper midweek?");
    expect(replies.map((r) => r.text)).toEqual(["flights are usually cheaper midweek"]);
    const turn = await q<{ gate_decision: string; gate_reason: string }>(`SELECT gate_decision, gate_reason FROM turns WHERE route = 'agent' AND gate_decision IS NOT NULL ORDER BY id DESC LIMIT 1`);
    expect(turn[0]).toEqual({ gate_decision: "SPEAK", gate_reason: "trip question to the room" });
  });

  it("fails closed when the gate errors", async () => {
    const llm = new FakeLlm({ extract: () => jsonResult({ facts: [], tensions: [] }), agent: () => textResult("NO_REPLY") }); // no gate handler → throws
    t = await testAtlas({ llm });
    const chat = t.chat("g4", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    expect(await chat.say("maya", "what should we do about flights")).toEqual([]);
    expect(llm.calls.filter((c) => c.role === "agent")).toHaveLength(3); // only the 3 replies to the intro question
  });

  it("stay quiet / talk again", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("g5", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    llm.set("gate", () => jsonResult({ decision: "SPEAK", reason: "x" }));
    llm.set("agent", () => textResult("on it"));
    const gateCalls = () => llm.calls.filter((c) => c.role === "gate").length;
    const before = gateCalls();
    expect((await chat.say("maya", "atlas stay quiet for a bit"))[0]!.text).toMatch(/i'll stay quiet unless someone tags me/);
    expect(await chat.say("leo", "what's the move for food tonight?")).toEqual([]);
    expect(gateCalls()).toBe(before);
    expect((await chat.say("leo", "atlas can you help with flights?"))[0]!.text).toBe("on it");
    expect((await chat.say("maya", "atlas you can talk again"))[0]!.text).toMatch(/i'm back/);
  });

  it("drops model text with a dollar figure no tool produced", async () => {
    const llm = quietFake().set("agent", () => textResult("it'll be about $480 each"));
    t = await testAtlas({ llm });
    const chat = t.chat("g6", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    const replies = await chat.say("maya", "atlas how much will lisbon cost?");
    expect(replies.map((r) => r.text)).toEqual([`i don't want to guess at numbers. ask me "what's our budget" or "who owes who" and i'll pull them exactly`]);
    const guard = await q<{ reason: string }>(`SELECT reason FROM llm_traces WHERE role = 'guard'`);
    expect(guard[0]!.reason).toContain("$480");
  });

  it("stores validated facts from extraction and drops invalid ones", async () => {
    const llm = quietFake().set("extract", (req) => {
      const text = (req.contents[0]!.parts[0] as { text: string }).text;
      expect(text).toContain("0. [Maya] cancun is too pricey for me, and i'm vegetarian");
      return jsonResult({
        facts: [
          { message: 0, about: "maya", key: "destination", polarity: "negative", explicit: true, retracts: false, confidence: 0.9, quote: "cancun is too pricey for me", place: "Cancún" },
          { message: 0, about: "maya", key: "budget_comment", polarity: "negative", explicit: true, retracts: false, confidence: 0.9, quote: "too pricey", budget_kind: "too_expensive", budget_about: "Cancún" },
          { message: 0, about: "maya", key: "dietary", polarity: "positive", explicit: true, retracts: false, confidence: 0.95, quote: "i'm vegetarian", need: "vegetarian" },
          { message: 0, about: "bob", key: "dietary", polarity: "positive", explicit: true, retracts: false, confidence: 0.9, quote: "x", need: "vegan" },
          { message: 7, about: "maya", key: "dietary", polarity: "positive", explicit: true, retracts: false, confidence: 0.9, quote: "x", need: "vegan" },
          { message: 0, about: "maya", key: "date_window", polarity: "positive", explicit: true, retracts: false, confidence: 0.9, quote: "x", latest: "1999-01-01" },
        ],
        tensions: [],
      });
    });
    t = await testAtlas({ llm });
    const chat = t.chat("g7", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    await chat.say("maya", "cancun is too pricey for me, and i'm vegetarian");
    const facts = await q<{ key: string; polarity: string; quote: string }>(`SELECT key, polarity, quote FROM facts ORDER BY id`);
    expect(facts).toEqual([
      { key: "destination", polarity: "negative", quote: "cancun is too pricey for me" },
      { key: "budget_comment", polarity: "negative", quote: "too pricey" },
      { key: "dietary", polarity: "positive", quote: "i'm vegetarian" },
    ]);
    const extracted = await q<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE extracted_at IS NOT NULL`);
    expect(extracted[0]!.n).toBe(1);
  });

  it("asks each person for missing info at most once", async () => {
    let round = 0;
    const llm = quietFake().set("agent", () => (round++ % 2 === 0 ? callResult("ask_for_missing_info", {}) : textResult("NO_REPLY")));
    t = await testAtlas({ llm });
    const chat = t.chat("g8", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    const first = await chat.say("maya", "atlas let's plan something");
    expect(first.map((r) => r.text)).toEqual(["maya + leo + priya: what dates work for you, and where would you be leaving from?"]);
    const second = await chat.say("maya", "atlas ok what now");
    expect(second).toEqual([]);
  });

  it("answers in its own words when there's nobody left to ask", async () => {
    // Seen live: everyone had been asked, the tool posted nothing, and Atlas went silent.
    const afterTool = (req: GenerateRequest) => req.contents.at(-1)!.parts.some((p) => "functionResponse" in p);
    const llm = quietFake().set("agent", (req) => (afterTool(req) ? textResult("sounds like winter break works for maya. leo, priya, same?") : callResult("ask_for_missing_info", {})));
    t = await testAtlas({ llm });
    const chat = t.chat("g10", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    expect((await chat.say("maya", "atlas let's plan something")).map((r) => r.text)).toEqual([
      "maya + leo + priya: what dates work for you, and where would you be leaving from?",
    ]);
    expect((await chat.say("maya", "atlas i'm free over winter break")).map((r) => r.text)).toEqual(["sounds like winter break works for maya. leo, priya, same?"]);
  });

  it("follows up on its own once the group goes quiet after an unanswered message", async () => {
    const clock = new OffsetClock();
    setClock(clock);
    try {
      const followingUp = (req: GenerateRequest) => JSON.stringify(req.contents).includes("following up on your own");
      const llm = quietFake().set("agent", (req) => (followingUp(req) ? textResult("maya's free nov 12-16. leo, priya, does that work for you?") : textResult("NO_REPLY")));
      t = await testAtlas({ llm, env: { NUDGE_IDLE_SECONDS: "60" } });
      const chat = t.chat("g11", ["maya", "leo", "priya"]);
      await pastIntro(chat);
      expect(await chat.say("maya", "i'm free nov 12-16 btw")).toEqual([]);
      const before = chat.lastEntry();

      await t.app.jobs.runDue();
      await t.world.waitIdle("g11");
      expect(chat.atlasSince(before)).toEqual([]); // not quiet long enough yet

      clock.advance(90_000);
      await t.app.jobs.runDue();
      await t.world.waitIdle("g11");
      expect(chat.atlasSince(before).map((e) => e.text)).toEqual(["maya's free nov 12-16. leo, priya, does that work for you?"]);

      // Atlas has the last word now, so there's nothing more to follow up on.
      clock.advance(10 * 60_000);
      await t.app.jobs.runDue();
      await t.world.waitIdle("g11");
      expect(chat.atlasSince(before)).toHaveLength(1);
      const routes = await q<{ route: string }>(`SELECT route FROM turns WHERE route LIKE 'nudge%'`);
      expect(routes.map((r) => r.route)).toEqual(["nudge"]);
    } finally {
      setClock(systemClock);
    }
  });

  it("doesn't follow up when quiet mode is on", async () => {
    const llm = quietFake().set("agent", () => textResult("hello?"));
    t = await testAtlas({ llm, env: { NUDGE_IDLE_SECONDS: "1" } });
    const chat = t.chat("g12", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    await chat.say("maya", "atlas stay quiet");
    await chat.say("leo", "so where are we going");
    await new Promise((r) => setTimeout(r, 1_100));
    await t.app.jobs.runDue();
    await t.world.waitIdle("g12");
    expect(chat.lastEntry()?.text).toBe("so where are we going");
  });
});
