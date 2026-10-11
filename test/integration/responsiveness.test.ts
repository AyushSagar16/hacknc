// Atlas answers the people who need it: someone answering the question it just asked them, someone
// who booked something or wants to move on, a trip question to the room. Bugs from a real group chat.
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../../src/db/pool.ts";
import { jsonResult, textResult, type GenerateRequest } from "../../src/agent/llm.ts";
import { BOOKED_FALLBACK, UNPROMPTED_PER_HOUR } from "../../src/agent/brain.ts";
import { now } from "../../src/clock.ts";
import { findChat } from "../../src/db/repos/core.ts";
import { dbAvailable } from "../helpers/db.ts";
import { pastIntro, quietFake, testAtlas, type TestAtlas } from "../helpers/atlas.ts";

const describeDb = dbAvailable ? describe : describe.skip;
const situationOf = (req: GenerateRequest) => (req.contents[0]!.parts[0] as { text: string }).text;
const lastTurn = async () => (await q<{ route: string; trigger: string | null; prompted: boolean | null; silent_why: string | null }>(`SELECT route, trigger, prompted, silent_why FROM turns ORDER BY id DESC LIMIT 1`))[0]!;

const BOARD_BEFORE = "how everyone gets there 🚗\n- maya: drive from raleigh, ~3h\n- priya: need to know where you're leaving from";
const BOARD_AFTER = "how everyone gets there 🚗\n- maya: drive from raleigh, ~3h\n- priya: drive from chapel hill, ~2h";

describeDb("responsiveness", () => {
  let t: TestAtlas | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it("an answer to the question atlas just asked gets the updated board, even after a board with no '?' (live chat 73)", async () => {
    const llm = quietFake(); // the gate would say NO_REPLY
    t = await testAtlas({ llm });
    const chat = t.chat("r1", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    llm.set("agent", () => textResult(`got it. priya, where are you driving from?\n\n${BOARD_BEFORE}`));
    const asked = await chat.say("maya", "atlas we're all driving, i'm leaving from raleigh");
    expect(asked.map((m) => m.text)).toEqual(["got it. priya, where are you driving from?", BOARD_BEFORE]);
    const gateCalls = llm.calls.filter((c) => c.role === "gate").length;
    llm.set("agent", () => textResult(BOARD_AFTER));
    const reply = await chat.say("priya", "i'm driving from unc chapel hill");
    expect(reply.map((m) => m.text)).toEqual([BOARD_AFTER]);
    expect(llm.calls.filter((c) => c.role === "gate").length).toBe(gateCalls);
    expect(await lastTurn()).toMatchObject({ route: "agent", trigger: "answers_question", prompted: true, silent_why: null });
  });

  it("an answer still counts when others talked (and atlas replied) in between", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("r2", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    llm.set("agent", () => textResult("priya, where are you driving from?"));
    await chat.say("maya", "atlas we're driving, can you sort out who's coming from where");
    llm.set("agent", () => textResult("nov 12-14 works for the group so far"));
    await chat.say("leo", "atlas what dates are we looking at");
    await chat.say("maya", "cool cool");
    await chat.say("leo", "nice");
    llm.set("agent", () => textResult("chapel hill to the coast is about 2h, priya"));
    const reply = await chat.say("priya", "chapel hill");
    expect(reply.map((m) => m.text)).toEqual(["chapel hill to the coast is about 2h, priya"]);
    expect((await lastTurn()).trigger).toBe("answers_question");
  });

  it("'i booked one of the hotels let's move on' reaches atlas without the gate, and never ends in just a 👍", async () => {
    const llm = quietFake(); // agent says NO_REPLY every time
    t = await testAtlas({ llm });
    const chat = t.chat("r3", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    const gateCalls = llm.calls.filter((c) => c.role === "gate").length;
    const reply = await chat.say("maya", "I booked one of the hotels let’s move on");
    expect(llm.calls.filter((c) => c.role === "gate").length).toBe(gateCalls);
    const agentCall = llm.calls.filter((c) => c.role === "agent").at(-1)!;
    expect(situationOf(agentCall)).toMatch(/booked something/);
    expect(reply.map((m) => m.text)).toEqual([BOOKED_FALLBACK]);
    expect(await lastTurn()).toMatchObject({ trigger: "booked", prompted: true });
  });

  it("'what's next' gets the next step", async () => {
    const llm = quietFake().set("agent", () => textResult("next up is dates: maya, leo, priya, when are you free?"));
    t = await testAtlas({ llm });
    const chat = t.chat("r4", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    expect((await chat.say("leo", "ok what’s next")).map((m) => m.text)).toEqual(["next up is dates: maya, leo, priya, when are you free?"]);
    expect((await lastTurn()).trigger).toBe("move_on");
  });

  it("the unprompted cap never silences someone who needed atlas", async () => {
    const llm = quietFake().set("agent", () => textResult("highs around 70"));
    t = await testAtlas({ llm });
    const chat = t.chat("r5", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    const row = (await findChat("sim", "r5"))!;
    for (let i = 0; i < UNPROMPTED_PER_HOUR + 5; i++)
      await q(`INSERT INTO turns (chat_id, started_at, status, route, addressed) VALUES ($1, $2, 'done', 'agent', false)`, [row.id, now()]);
    expect((await chat.say("priya", "what's the weather like there in november?")).map((m) => m.text)).toEqual(["highs around 70"]);
    // ...while a chime-in the gate wanted is capped.
    llm.set("gate", () => jsonResult({ decision: "SPEAK", reason: "could help" }));
    expect(await chat.say("leo", "beach trips are the best trips")).toEqual([]);
    expect((await lastTurn()).silent_why).toMatch(/unprompted cap/);
  });
});
