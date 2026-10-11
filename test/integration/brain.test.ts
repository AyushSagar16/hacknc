import { afterEach, describe, expect, it } from "vitest";
import { q } from "../../src/db/pool.ts";
import { callResult, FakeLlm, jsonResult, textResult, type GenerateRequest } from "../../src/agent/llm.ts";
import { OffsetClock, setClock, systemClock } from "../../src/clock.ts";
import { dbAvailable } from "../helpers/db.ts";
import { pastIntro, quietFake, testAtlas, type TestAtlas } from "../helpers/atlas.ts";

const describeDb = dbAvailable ? describe : describe.skip;
/** The deterministic ask when everyone is missing dates and home city (wording varies by chat). */
const ASK_EVERYONE = /everyone.*:\n- when you're free\n- where you'd be leaving from/;
const situationOf = (req: GenerateRequest) => (req.contents[0]!.parts[0] as { text: string }).text;
const lastText = (req: GenerateRequest) =>
  req.contents
    .at(-1)!
    .parts.map((p) => ("text" in p ? p.text : ""))
    .join(" ");

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
    expect(intro[1]!.text).toContain("only ever sees pooled numbers");
    expect(intro[2]!.text).toMatch(/want to connect your capital one so i can plan around real budgets\?$/);
    expect(intro.map((m) => m.text).join("\n")).not.toMatch(/demo|sandbox|nessie|synthetic/i);
    // Right after the intro's question, a message may be an answer: the agent decides (NO_REPLY here).
    expect(await chat.say("leo", "lol did you see the game")).toEqual([]);
    expect(llm.calls.filter((c) => c.role === "agent")).toHaveLength(1);
    for (const text of ["haha yes", "insane", "that game was wild"]) expect(await chat.say("priya", text)).toEqual([]);
    // Off-topic chatter ("that game was wild") never reaches the gate: nothing about the trip to weigh.
    expect(llm.calls.filter((c) => c.role === "gate")).toHaveLength(0);
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
    const replies = await chat.say("leo", "i heard flights are cheaper midweek");
    expect(replies.map((r) => r.text)).toEqual(["flights are usually cheaper midweek"]);
    const turn = await q<{ gate_decision: string; gate_reason: string }>(`SELECT gate_decision, gate_reason FROM turns WHERE route = 'agent' AND gate_decision IS NOT NULL ORDER BY id DESC LIMIT 1`);
    expect(turn[0]).toEqual({ gate_decision: "SPEAK", gate_reason: "trip question to the room" });
  });

  it("when the gate errors, banter stays quiet but trip talk still gets an answer", async () => {
    const llm = new FakeLlm({ extract: () => jsonResult({ facts: [], tensions: [] }), agent: () => textResult("NO_REPLY") }); // no gate handler → throws
    t = await testAtlas({ llm });
    const chat = t.chat("g4", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    expect(await chat.say("maya", "lol that was so true yesterday")).toEqual([]);
    expect(llm.calls.filter((c) => c.role === "agent")).toHaveLength(2); // only "alright" and "cool" answering the intro question (a bare "ok" to the room answers nothing)
    llm.set("agent", () => textResult("nice, that unlocks the dates"));
    expect((await chat.say("leo", "i'm in charlotte and free march 7-15")).map((r) => r.text)).toEqual(["nice, that unlocks the dates"]);
    const turn = await q<{ gate_reason: string }>(`SELECT gate_reason FROM turns WHERE route = 'agent' ORDER BY id DESC LIMIT 1`);
    expect(turn[0]!.gate_reason).toMatch(/shared trip details/);
  });

  it("questions to the room, objections and changes of mind skip the gate and get an answer", async () => {
    const llm = quietFake(); // the gate would say NO_REPLY
    t = await testAtlas({ llm });
    const chat = t.chat("g4b", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    const gateCalls = () => llm.calls.filter((c) => c.role === "gate").length;
    const before = gateCalls();
    llm.set("agent", () => textResult("highs around 50, lows near 30"));
    expect((await chat.say("leo", "what's the typical high and low temp in december there tho")).map((r) => r.text)).toEqual(["highs around 50, lows near 30"]);
    llm.set("agent", () => textResult("each share is your own travel plus an equal part of the rest"));
    expect((await chat.say("priya", "how is the split calculated?")).length).toBe(1);
    llm.set("agent", () => textResult("got it ana. we can look at cheaper spots"));
    expect((await chat.say("maya", "honestly that's too expensive for me")).length).toBe(1);
    llm.set("agent", () => textResult("ana wants asheville instead. luis, carmen, switch?"));
    expect((await chat.say("maya", "hmm actually can we do asheville instead? the lights there are better")).length).toBe(1);
    expect(gateCalls()).toBe(before);
    // A question for one friend is still theirs to answer.
    expect(await chat.say("leo", "priya do u have a car or are we flying")).toEqual([]);
  });

  it("stay quiet / talk again", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("g5", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    llm.set("gate", () => jsonResult({ decision: "SPEAK", reason: "x" }));
    llm.set("agent", () => textResult("flights from rdu are cheapest midweek"));
    const gateCalls = () => llm.calls.filter((c) => c.role === "gate").length;
    const before = gateCalls();
    expect((await chat.say("maya", "atlas stay quiet for a bit"))[0]!.text).toMatch(/i'll stay quiet unless someone tags me/);
    expect(await chat.say("leo", "what's the move for food tonight?")).toEqual([]);
    expect(gateCalls()).toBe(before);
    expect((await chat.say("leo", "atlas can you help with flights?"))[0]!.text).toBe("flights from rdu are cheapest midweek");
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
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toMatch(ASK_EVERYONE);
    // Asked again by name with nobody left to ask: no second ask, but never silence either.
    const second = await chat.say("maya", "atlas ok what now");
    expect(second.map((r) => r.text)).toHaveLength(1);
    expect(second[0]!.text).not.toMatch(/when you're free/);
    expect(second[0]!.text).toMatch(/^i'm here\. where things stand:\n- still need: maya's dates \+ home city/);
  });

  it("answers in its own words when there's nobody left to ask", async () => {
    // Seen live: everyone had been asked, the tool posted nothing, and Atlas went silent.
    const afterTool = (req: GenerateRequest) => req.contents.at(-1)!.parts.some((p) => "functionResponse" in p);
    const llm = quietFake().set("agent", (req) => (afterTool(req) ? textResult("sounds like winter break works for maya. leo, priya, same?") : callResult("ask_for_missing_info", {})));
    t = await testAtlas({ llm });
    const chat = t.chat("g10", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    const asked = await chat.say("maya", "atlas let's plan something");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.text).toMatch(ASK_EVERYONE);
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
  it("when the gate says SPEAK, the agent is told why and answers instead of second-guessing", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("g13", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    llm.set("gate", () => jsonResult({ decision: "SPEAK", reason: "everyone voted: announce the winner" }));
    llm.set("agent", (req) => (situationOf(req).includes("you're chiming in because: everyone voted: announce the winner") ? textResult("lisbon it is 🎉") : textResult("NO_REPLY")));
    const replies = await chat.say("leo", "ok everyone voted");
    expect(replies.map((r) => r.text)).toEqual(["lisbon it is 🎉"]);
    const situation = situationOf(llm.calls.filter((c) => c.role === "agent").at(-1)!);
    expect(situation).not.toContain("often wrong");
  });

  it("an untagged reply keeps a list together with its lead-in", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("g19", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    llm.set("gate", () => jsonResult({ decision: "SPEAK", reason: "leo asked what to do in lisbon" }));
    llm.set("agent", () => textResult("a few lisbon picks, leo:\n\n- alfama at sunset\n- belém pastries\n\nwant me to add them to the plan?"));
    expect((await chat.say("leo", "what should we do there"))[0]!.text).toBe("a few lisbon picks, leo:\n- alfama at sunset\n- belém pastries");
  });

  it("an untagged NO_REPLY is respected without a retry", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("g14", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    llm.set("gate", () => jsonResult({ decision: "SPEAK", reason: "trip talk" }));
    const before = llm.calls.filter((c) => c.role === "agent").length;
    expect(await chat.say("leo", "lol maya you'd hate the beach")).toEqual([]);
    expect(llm.calls.filter((c) => c.role === "agent").length - before).toBe(1);
  });

  it("retries once when the model returns only thoughts (empty text)", async () => {
    // Seen live: gemini flash-lite returned only thought parts, the text was "" and nothing was sent.
    const llm = quietFake().set("agent", (req) =>
      lastText(req).includes("came back empty") ? textResult("gatlinburg in december is cozy: cabins, the smokies, dollywood's lights") : { text: "", functionCalls: [], parts: [{ text: "thinking...", thought: true }] },
    );
    t = await testAtlas({ llm });
    const chat = t.chat("g15", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    const replies = await chat.say("maya", "atlas what is there to do?");
    expect(replies.map((r) => r.text)).toEqual(["gatlinburg in december is cozy: cabins, the smokies, dollywood's lights"]);
    const agentCalls = llm.calls.filter((c) => c.role === "agent");
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[1]!.thinking).toBe("minimal");
  });

  it("never stays silent when named, even if the model keeps coming back empty", async () => {
    const llm = quietFake().set("agent", () => ({ text: "", functionCalls: [], parts: [{ text: "hmm", thought: true }] }));
    t = await testAtlas({ llm });
    const chat = t.chat("g16", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    const replies = await chat.say("maya", "UNC winter break, I'm free. Atlas. Let's keep moving.");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toMatch(/^i'm here\. where things stand:/);
    expect(llm.calls.filter((c) => c.role === "agent")).toHaveLength(2);
  });

  it("pushes back once on a NO_REPLY to someone who named atlas", async () => {
    const llm = quietFake().set("agent", (req) => (lastText(req).includes("NO_REPLY isn't an option") ? textResult("still waiting on leo and priya's dates") : textResult("NO_REPLY")));
    t = await testAtlas({ llm });
    const chat = t.chat("g17", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    expect((await chat.say("maya", "atlas what happened")).map((r) => r.text)).toEqual(["still waiting on leo and priya's dates"]);
  });

  it("points the agent at named date periods it should look up", async () => {
    const llm = quietFake().set("extract", () =>
      jsonResult({
        facts: [{ message: 0, about: "maya", key: "date_window", polarity: "positive", explicit: true, retracts: false, confidence: 0.8, quote: "i'm free during nc state's winter break" }],
        tensions: [],
      }),
    );
    llm.set("agent", () => textResult("ok"));
    t = await testAtlas({ llm });
    const chat = t.chat("g18", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    await chat.say("maya", "i'm free during nc state's winter break");
    await chat.say("maya", "atlas so when are we going");
    const situation = situationOf(llm.calls.filter((c) => c.role === "agent").at(-1)!);
    expect(situation).toContain(`dates given as a named period, not exact days: Maya ("i'm free during nc state's winter break")`);
    expect(situation).toContain("set_trip_dates");
  });

  it("never sends a bare promise: one more round asks for the tool or a direct answer", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("g-promise", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    let n = 0;
    llm.set("agent", (req) => {
      n += 1;
      if (n === 1) return textResult("got it, let me look for beach spots under 800.");
      expect(lastText(req)).toMatch(/you can't come back later/);
      return textResult("under 800 each, myrtle beach and wilmington fit (est.)");
    });
    const replies = await chat.say("maya", "atlas can u show beach options under like 800 each");
    expect(replies.map((r) => r.text)).toEqual(["under 800 each, myrtle beach and wilmington fit (est.)"]);
  });

  it("a promise that survives the nudge is cut, never sent", async () => {
    const llm = quietFake().set("agent", () => textResult("one sec, pulling those now"));
    t = await testAtlas({ llm });
    const chat = t.chat("g-promise2", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    const replies = await chat.say("maya", "atlas can u show beach options under like 800 each");
    expect(replies.map((r) => r.text).join("\n")).not.toMatch(/one sec|pulling/);
  });

  it("a command's reply doesn't wait for a slow extraction", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("g-fastcmd", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    llm.set("extract", async () => {
      await gate;
      return jsonResult({ facts: [], tensions: [] });
    });
    const started = Date.now();
    const replies = await chat.say("priya", "atlas keep my budget private");
    expect(replies[0]!.text).toMatch(/private/);
    expect(Date.now() - started).toBeLessThan(3_000);
    release();
  });
});
