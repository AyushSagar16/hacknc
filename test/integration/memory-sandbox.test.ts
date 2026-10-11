// Each group chat is its own memory sandbox: what a person said while planning with one group
// (diet, home city, dates, vetoes) never reaches another group's itinerary, even with them in both.
import { afterEach, describe, expect, it } from "vitest";
import { now } from "../../src/clock.ts";
import { one, q } from "../../src/db/pool.ts";
import { findChat } from "../../src/db/repos/core.ts";
import { jsonResult, textResult, type GenerateRequest } from "../../src/agent/llm.ts";
import { memoryFeature } from "../../src/agent/features/memory.ts";
import { recall } from "../../src/memory/retrieve.ts";
import { insertFacts, profilesFor } from "../../src/profile/store.ts";
import { dbAvailable } from "../helpers/db.ts";
import { quietFake, testAtlas, type TestAtlas } from "../helpers/atlas.ts";

const describeDb = dbAvailable ? describe : describe.skip;

const MAYA = { name: "maya", handle: "+15550200001" };
const LEO = { name: "leo", handle: "+15550200002" };
const SAM = { name: "sam", handle: "+15550200003" };
const PRIYA = { name: "priya", handle: "+15550200004" };

const promptOf = (req: GenerateRequest) => (req.contents[0]!.parts[0] as { text: string }).text;

/** Scripted extraction: Maya's planning message in the first chat yields four facts about her. */
const mayaExtract = (req: GenerateRequest) => {
  const m = /^(\d+)\. \[Maya\] .*vegetarian/m.exec(promptOf(req));
  if (!m) return jsonResult({ facts: [], tensions: [] });
  const base = { message: Number(m[1]), about: "maya", explicit: true, retracts: false, confidence: 0.95 };
  return jsonResult({
    facts: [
      { ...base, key: "dietary", polarity: "positive", quote: "i'm vegetarian", need: "vegetarian" },
      { ...base, key: "home_city", polarity: "neutral", quote: "flying from denver", city: "Denver" },
      { ...base, key: "date_window", polarity: "positive", quote: "free dec 15 to 20", earliest: "2026-12-15", latest: "2026-12-20" },
      { ...base, key: "destination", polarity: "negative", quote: "not miami", place: "Miami" },
    ],
    tensions: [],
  });
};

const LEAKS = [/vegetarian/i, /denver/i, /miami/i, /12-15|dec 15/i];

async function chatIdOf(providerId: string): Promise<number> {
  return (await findChat("sim", providerId))!.id;
}

async function personIdOf(handle: string): Promise<number> {
  return (await one<{ id: number }>(`SELECT id FROM people WHERE handle = $1`, [handle]))!.id;
}

describeDb("memory sandbox per group chat", () => {
  let t: TestAtlas | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it("keeps one group's facts about a person out of another group's planning", async () => {
    const llm = quietFake().set("extract", mayaExtract);
    t = await testAtlas({ llm, features: [memoryFeature] });
    const a = t.world.chat("sandbox-a", [MAYA, LEO]);
    const b = t.world.chat("sandbox-b", [MAYA, SAM, PRIYA]);
    await a.addAtlas();
    await b.addAtlas();
    await a.say("maya", "i'm vegetarian, flying from denver, free dec 15 to 20, and not miami");
    await t.app.jobs.runDue();

    const chatA = await chatIdOf("sandbox-a");
    const chatB = await chatIdOf("sandbox-b");
    const maya = await personIdOf(MAYA.handle);

    // The first chat knows all four things about Maya.
    const inA = (await profilesFor([maya], { chatId: chatA })).get(maya)!;
    expect(inA.dietary.map((d) => d.value)).toEqual(["vegetarian"]);
    expect(inA.homeCity?.value).toBe("Denver");
    expect(inA.earliest?.value).toBe("2026-12-15");
    expect(inA.vetoes.map((v) => v.value)).toEqual(["Miami"]);

    // The second chat knows none of them.
    const inB = (await profilesFor([maya], { chatId: chatB })).get(maya)!;
    expect(inB.dietary).toEqual([]);
    expect(inB.homeCity).toBeUndefined();
    expect(inB.earliest).toBeUndefined();
    expect(inB.latest).toBeUndefined();
    expect(inB.vetoes).toEqual([]);

    // A turn in the second chat: neither the extractor nor the agent hears about the first chat.
    let extractPrompt = "";
    let agentPrompt = "";
    llm.set("extract", (req) => {
      extractPrompt = promptOf(req);
      return jsonResult({ facts: [], tensions: [] });
    });
    llm.set("agent", (req) => {
      agentPrompt = promptOf(req);
      return textResult("where's everyone thinking?");
    });
    await b.say("sam", "ok");
    await b.say("maya", "atlas where should we go this winter?");
    expect(agentPrompt).not.toBe("");
    expect(extractPrompt).toContain("- maya: dates unknown; leaving from unknown");
    for (const leak of LEAKS) {
      expect(agentPrompt).not.toMatch(leak);
      expect(extractPrompt).not.toMatch(leak);
    }

    // Recall in the second chat finds nothing from the first.
    const hits = await recall({ llm, chatId: chatB, memberIds: [maya, await personIdOf(SAM.handle)], query: "vegetarian denver miami december", isGroup: true, now: now() });
    for (const leak of LEAKS) expect(hits.some((h) => leak.test(h.content))).toBe(false);
  });

  it("always stamps a trip fact with a trip, so it can't float onto every trip in the chat", async () => {
    t = await testAtlas();
    const a = t.world.chat("sandbox-trip", [MAYA, LEO]);
    await a.addAtlas();
    const chatId = await chatIdOf("sandbox-trip");
    const maya = await personIdOf(MAYA.handle);
    // A chat with no focused trip yet: the fact still gets one.
    await q(`UPDATE chats SET focus_trip_id = NULL WHERE id = $1`, [chatId]);
    const base = { personId: maya, chatId, polarity: "positive" as const, explicit: true, confidence: 0.9, sourceMessageId: null, quote: null, observedAt: now(), retracted: false };
    await insertFacts([{ ...base, key: "date_window", value: { earliest: "2026-12-15", latest: "2026-12-20" } }]);
    const rows = await q<{ trip_id: number | null }>(`SELECT trip_id FROM facts WHERE person_id = $1 AND key = 'date_window'`, [maya]);
    const focus = await one<{ focus_trip_id: number | null }>(`SELECT focus_trip_id FROM chats WHERE id = $1`, [chatId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trip_id).not.toBeNull();
    expect(rows[0]!.trip_id).toBe(focus!.focus_trip_id);

    // And a legacy trip fact with no trip is ignored when reading a trip, while person facts still count.
    await q(
      `INSERT INTO facts (person_id, chat_id, key, value, polarity, explicit, confidence, observed_at, trip_id)
       VALUES ($1, $2, 'destination', '{"name":"Miami"}', 'negative', true, 0.9, $3, NULL),
              ($1, $2, 'dietary', '{"need":"vegan"}', 'positive', true, 0.9, $3, NULL)`,
      [maya, chatId, now()],
    );
    const p = (await profilesFor([maya], { chatId, tripId: focus!.focus_trip_id! })).get(maya)!;
    expect(p.vetoes).toEqual([]);
    expect(p.dietary.map((d) => d.value)).toEqual(["vegan"]);
  });
});
