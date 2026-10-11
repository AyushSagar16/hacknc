import { afterEach, describe, expect, it } from "vitest";
import { now } from "../../src/clock.ts";
import { q } from "../../src/db/pool.ts";
import { findChat } from "../../src/db/repos/core.ts";
import { memoryFeature, SAID_SECTION_TITLE, selfMemoryFeature } from "../../src/agent/features/memory.ts";
import { classify, fieldsAsked, logSent, openAsks, restates, targetsOf } from "../../src/memory/atlasLog.ts";
import { recall } from "../../src/memory/retrieve.ts";
import { dbAvailable } from "../helpers/db.ts";
import { testAtlas, type TestAtlas } from "../helpers/atlas.ts";

const describeDb = dbAvailable ? describe : describe.skip;

describe("atlas_log classification", () => {
  it("tells asks, follow-ups, proposals, decisions and money apart", () => {
    expect(classify("sol and ravi, when are you free in january?", { unprompted: false })).toBe("ask");
    expect(classify("sol and ravi, cast your votes in the poll above", { unprompted: true })).toBe("nudge");
    expect(classify("1. gatlinburg — ~$630 each", { unprompted: false })).toBe("proposal");
    expect(classify("🎉 gatlinburg it is! unanimous, 4 for 4", { unprompted: false })).toBe("decision");
    expect(classify("sai: $430 total\n4 payments of $107.50", { unprompted: false })).toBe("money");
    expect(classify("gatlinburg's got great hikes this time of year", { unprompted: false })).toBe("answer");
  });

  it("finds who a bubble names and which details it asks for", () => {
    const members = [
      { id: 1, first: "sai" },
      { id: 2, first: "ravi" },
      { id: 3, first: "kim" },
    ];
    expect(targetsOf("sai and ravi, drop your votes", members)).toEqual([1, 2]);
    expect(targetsOf("saint louis is nice", members)).toEqual([]);
    expect(fieldsAsked("when you're free, and where you'd be leaving from?")).toEqual(["dates", "home_city"]);
  });
});

describeDb("atlas_log in Postgres", () => {
  let t: TestAtlas | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it("logs what Atlas sends and recognizes a restated nudge (pg_trgm)", async () => {
    t = await testAtlas({ features: [memoryFeature, selfMemoryFeature] });
    const chat = t.chat("log", ["sol", "ravi", "kim"]);
    await chat.addAtlas();
    const chatId = (await findChat("sim", "log"))!.id;
    const rows = await q<{ kind: string }>(`SELECT kind FROM atlas_log WHERE chat_id = $1`, [chatId]);
    expect(rows.length).toBeGreaterThan(0); // the intro went through the pipeline and was logged

    await logSent({ chatId, turnId: null, text: "sol and ravi, cast your votes in the poll above to break the tie between denver and san juan.", unprompted: true, actionType: "say", at: now() });
    const again = await restates(chatId, "sol and ravi, drop your votes in the poll above so we can break the tie between denver and san juan.", now());
    expect(again?.similarity).toBeGreaterThan(0.6);
    expect(await restates(chatId, "denver it is! 3 of 5 votes", now())).toBeUndefined();

    const open = await openAsks(chatId, now());
    const nudge = open.find((a) => a.kind === "nudge")!;
    expect(nudge.waitingOn.length).toBe(2);
    await chat.say("sol", "ok voted");
    const after = (await openAsks(chatId, now())).find((a) => a.kind === "nudge")!;
    expect(after.waitingOn.length).toBe(1);
    expect(after.answered.length).toBe(1);
  });

  it("shows the agent its open asks", async () => {
    t = await testAtlas({ features: [memoryFeature, selfMemoryFeature] });
    const chat = t.chat("said", ["sol", "ravi"]);
    await chat.addAtlas();
    const chatId = (await findChat("sim", "said"))!.id;
    await logSent({ chatId, turnId: null, text: "ravi, when are you free in january?", unprompted: false, actionType: "say", at: now() });
    const section = await selfMemoryFeature.situation!({ chat: { id: chatId }, now: now(), label: (id: number) => (id ? "Ravi" : "atlas") } as never);
    expect(section?.title).toBe(SAID_SECTION_TITLE);
    expect(section?.lines[0]).toMatch(/"ravi, when are you free in january\?" → still waiting on ravi/);
  });

  it("recalls by keyword (BM25) as well as by meaning, and skips content-free queries", async () => {
    t = await testAtlas({ features: [memoryFeature] });
    const chat = t.chat("hyb", ["maya", "leo"]);
    await chat.addAtlas();
    await chat.say("leo", "the airbnb in gatlinburg had a hot tub");
    await chat.say("maya", "i can only do weekends");
    await t.app.jobs.runDue();
    const chatId = (await findChat("sim", "hyb"))!.id;
    const members = (await q<{ person_id: number }>(`SELECT person_id FROM chat_members WHERE chat_id = $1`, [chatId])).map((r) => r.person_id);
    let embeds = 0;
    const embed = t.llm.embed.bind(t.llm);
    t.llm.embed = (texts, kind) => ((embeds += 1), embed(texts, kind));
    const hits = await recall({ llm: t.llm, chatId, memberIds: members, query: "gatlinburg?", isGroup: true, now: now() });
    expect(hits[0]?.content).toContain("gatlinburg had a hot tub");
    expect(hits[0]?.lexical).toBe(true);
    expect(await recall({ llm: t.llm, chatId, memberIds: members, query: "ok yes", isGroup: true, now: now() })).toEqual([]);
    expect(embeds).toBe(0); // one keyword is a BM25 search; "ok yes" has no content at all
  });
});
