// Hot-path recall: skip the embed call when nothing is recallable, and let an early warm-up's
// embedding be reused by the turn's own recall.
import { afterEach, describe, expect, it } from "vitest";
import { now } from "../../src/clock.ts";
import { q } from "../../src/db/pool.ts";
import { findChat } from "../../src/db/repos/core.ts";
import { memoryFeature } from "../../src/agent/features/memory.ts";
import { recall, warmRecall } from "../../src/memory/retrieve.ts";
import { dbAvailable } from "../helpers/db.ts";
import { testAtlas, type TestAtlas } from "../helpers/atlas.ts";

const describeDb = dbAvailable ? describe : describe.skip;

describeDb("recall on the hot path", () => {
  let t: TestAtlas | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  async function seeded() {
    t = await testAtlas({ features: [memoryFeature] });
    const chat = t.chat("warm-a", ["maya", "leo"]);
    await chat.addAtlas();
    await chat.say("leo", "i went to lisbon last year and the food was unreal");
    await t.app.jobs.runDue();
    const chatId = (await findChat("sim", "warm-a"))!.id;
    const members = (await q<{ id: number }>(`SELECT person_id AS id FROM chat_members WHERE chat_id = $1`, [chatId])).map((r) => r.id);
    let embeds = 0;
    const llm = t.llm;
    const original = llm.embed.bind(llm);
    llm.embed = (texts, kind) => {
      embeds += 1;
      return original(texts, kind);
    };
    return { chatId, members, llm, embeds: () => embeds };
  }

  it("doesn't embed the query when every chunk is made of messages the agent already sees", async () => {
    const { chatId, members, llm, embeds } = await seeded();
    const all = (await q<{ id: number }>(`SELECT id FROM messages WHERE chat_id = $1`, [chatId])).map((r) => r.id);
    const hits = await recall({ llm, chatId, memberIds: members, query: "lisbon food", isGroup: true, excludeMessageIds: all, now: now() });
    expect(hits).toEqual([]);
    expect(embeds()).toBe(0);
    // Without the exclusion the same chunks are found (one embed).
    const found = await recall({ llm, chatId, memberIds: members, query: "lisbon food", isGroup: true, now: now() });
    expect(found.length).toBeGreaterThan(0);
    expect(embeds()).toBe(1);
  });

  it("reuses a warm-up once, then recalls fresh", async () => {
    const { chatId, members, llm, embeds } = await seeded();
    const input = { llm, chatId, memberIds: members, query: "lisbon food", isGroup: true, now: now() };
    warmRecall(input);
    warmRecall(input); // idempotent while pending
    const warmed = await recall({ ...input, memberIds: [...members].reverse() });
    expect(embeds()).toBe(1);
    expect(warmed.length).toBeGreaterThan(0);
    const again = await recall(input);
    expect(again.map((h) => h.id)).toEqual(warmed.map((h) => h.id));
    expect(embeds()).toBe(2);
  });
});
