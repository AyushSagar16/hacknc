import { afterEach, describe, expect, it } from "vitest";
import { now, OffsetClock, setClock, systemClock } from "../../src/clock.ts";
import { one, q } from "../../src/db/pool.ts";
import { findChat, insertMessage, upsertChat } from "../../src/db/repos/core.ts";
import { callResult, jsonResult, textResult, type GenerateRequest } from "../../src/agent/llm.ts";
import { MEMORY_SECTION_TITLE, memoryFeature } from "../../src/agent/features/memory.ts";
import { embedTurn } from "../../src/memory/write.ts";
import { recall, recencyFactor } from "../../src/memory/retrieve.ts";
import { enqueueJob } from "../../src/pipeline/jobs.ts";
import { insertFacts } from "../../src/profile/store.ts";
import { dbAvailable } from "../helpers/db.ts";
import { pastIntro, quietFake, testAtlas, type TestAtlas } from "../helpers/atlas.ts";

const describeDb = dbAvailable ? describe : describe.skip;

const DAY = 86_400_000;
// Distinct handles per person so the same friend can be in two chats (simMembers numbers by position).
const MAYA = { name: "maya", handle: "+15550100001" };
const LEO = { name: "leo", handle: "+15550100002" };
const SAM = { name: "sam", handle: "+15550100003" };
const PRIYA = { name: "priya", handle: "+15550100004" };

const promptOf = (req: GenerateRequest) => (req.contents[0]!.parts[0] as { text: string }).text;

/** Scripted extraction: whenever Maya's new message mentions being vegetarian, report it. */
const vegetarianExtract = (req: GenerateRequest) => {
  const m = /^(\d+)\. \[Maya\] .*vegetarian/m.exec(promptOf(req));
  return jsonResult({
    facts: m
      ? [{ message: Number(m[1]), about: "maya", key: "dietary", polarity: "positive", explicit: true, retracts: false, confidence: 0.95, quote: "i'm vegetarian", need: "vegetarian" }]
      : [],
    tensions: [],
  });
};

async function chatIdOf(providerId: string): Promise<number> {
  return (await findChat("sim", providerId))!.id;
}

async function personIdOf(handle: string): Promise<number> {
  return (await one<{ id: number }>(`SELECT id FROM people WHERE handle = $1`, [handle]))!.id;
}

interface ChunkRow {
  id: number;
  chat_id: number | null;
  person_id: number | null;
  kind: string;
  content: string;
  visibility: string;
  source_ids: number[];
  meta: Record<string, unknown>;
  embedded: boolean;
}

const chunks = () =>
  q<ChunkRow>(`SELECT id, chat_id, person_id, kind, content, visibility, source_ids::int[] AS source_ids, meta, embedding IS NOT NULL AS embedded FROM memory_chunks ORDER BY id`);

describeDb("long-term memory", () => {
  let t: TestAtlas | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    setClock(systemClock);
  });

  it("embeds each turn into window + fact chunks in a background job, idempotently", async () => {
    const llm = quietFake().set("extract", vegetarianExtract);
    t = await testAtlas({ llm, features: [memoryFeature] });
    const chat = t.chat("mem-a", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    await chat.say("maya", "heads up i'm vegetarian so somewhere with good veggie food");
    const chatId = await chatIdOf("mem-a");
    const maya = await personIdOf("+15550100001");

    // Nothing is embedded inside the turn; one job per turn waits in the queue.
    expect(await chunks()).toEqual([]);
    const jobs = await q<{ payload: Record<string, unknown> }>(`SELECT payload FROM jobs WHERE kind = 'memory.embed' ORDER BY id`);
    expect(jobs).toHaveLength(2); // the intro turn (Atlas's lines) and Maya's message
    await t.app.jobs.runDue();

    const rows = await chunks();
    const windows = rows.filter((r) => r.kind === "message");
    expect(windows.map((w) => w.content)).toEqual([expect.stringMatching(/^\[atlas\] hi, i'm atlas, your trip and financial planner.*\n\[atlas\] .*\n\[atlas\] so where are we thinking, and when\?$/s), "[Maya] heads up i'm vegetarian so somewhere with good veggie food"]);
    expect(windows.every((w) => w.chat_id === chatId && w.visibility === "public" && w.person_id === null)).toBe(true);
    const mayaMsg = (await one<{ id: number }>(`SELECT id FROM messages WHERE text LIKE 'heads up%'`))!.id;
    expect(windows[1]!.source_ids).toEqual([mayaMsg]);

    const facts = rows.filter((r) => r.kind === "fact");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ person_id: maya, visibility: "public", content: `Maya: vegetarian (dietary) — "i'm vegetarian"`, source_ids: [mayaMsg] });
    expect(facts[0]!.meta).toMatchObject({ key: "dietary", factId: expect.any(Number) });
    expect(rows.every((r) => r.embedded)).toBe(true);
    const created = await q<{ created_at: Date; sent_at: Date }>(`SELECT c.created_at, m.sent_at FROM memory_chunks c JOIN messages m ON m.id = c.source_ids[1] WHERE c.kind = 'message' AND c.source_ids = ARRAY[$1]::bigint[]`, [mayaMsg]);
    expect(created[0]!.created_at.getTime()).toBe(created[0]!.sent_at.getTime());

    // Running the same work again creates nothing: covered messages and embedded facts are skipped.
    for (const j of jobs) await enqueueJob("memory.embed", j.payload);
    await t.app.jobs.runDue();
    const allIds = (await q<{ id: number }>(`SELECT id FROM messages WHERE chat_id = $1`, [chatId])).map((r) => r.id);
    expect(await embedTurn({ llm, chatId, messageIds: allIds })).toEqual({ windows: 0, facts: 0, ids: [] });
    expect((await chunks()).length).toBe(rows.length);
  });

  it("skips pure acknowledgements but keeps them when Atlas answered in the same turn", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm, features: [memoryFeature] });
    const chat = t.chat("mem-ack", ["maya", "leo", "priya"]);
    await pastIntro(chat); // "ok", "sure", "cool"
    llm.set("agent", () => textResult("great, here's where we are"));
    await chat.say("maya", "ok atlas");
    await t.app.jobs.runDue();
    const windows = (await chunks()).filter((r) => r.kind === "message").map((r) => r.content);
    expect(windows).toHaveLength(2);
    expect(windows[1]).toBe("[Maya] ok atlas\n[atlas] great, here's where we are");
  });

  it("never recalls one chat's history in another chat", async () => {
    t = await testAtlas({ features: [memoryFeature] });
    const a = t.world.chat("hist-a", [MAYA, LEO]);
    const b = t.world.chat("hist-b", [PRIYA, SAM]);
    await a.addAtlas();
    await b.addAtlas();
    await a.say("leo", "i went to lisbon last year and the food was unreal");
    await b.say("sam", "lisbon for the food?");
    await t.app.jobs.runDue();
    const chatA = await chatIdOf("hist-a");
    const chatB = await chatIdOf("hist-b");
    const membersA = [await personIdOf(MAYA.handle), await personIdOf(LEO.handle)];
    const membersB = [await personIdOf(PRIYA.handle), await personIdOf(SAM.handle)];
    const query = "lisbon food last year";

    const inB = await recall({ llm: t.llm, chatId: chatB, memberIds: membersB, query, isGroup: true, now: now() });
    expect(inB.map((h) => h.content)).toContain("[Sam] lisbon for the food?");
    const aChunkIds = new Set((await q<{ id: number }>(`SELECT id FROM memory_chunks WHERE chat_id = $1`, [chatA])).map((r) => r.id));
    expect(aChunkIds.size).toBeGreaterThan(0);
    expect(inB.filter((h) => aChunkIds.has(h.id))).toEqual([]);
    expect(inB.some((h) => h.content.includes("unreal"))).toBe(false);

    const inA = await recall({ llm: t.llm, chatId: chatA, memberIds: membersA, query, isGroup: true, now: now() });
    expect(inA[0]!.content).toBe("[Leo] i went to lisbon last year and the food was unreal");
    expect(inA.some((h) => h.content.includes("Sam"))).toBe(false);
  });

  it("doesn't recall fact chunks (resolved facts are already in every turn's situation), nor other chats' messages", async () => {
    const llm = quietFake().set("extract", vegetarianExtract);
    t = await testAtlas({ llm, features: [memoryFeature] });
    const a = t.world.chat("facts-a", [MAYA, LEO]);
    const b = t.world.chat("facts-b", [MAYA, SAM]);
    await a.addAtlas();
    await b.addAtlas();
    await a.say("maya", "fyi i'm vegetarian btw");
    await t.app.jobs.runDue();
    const chatB = await chatIdOf("facts-b");
    const maya = await personIdOf(MAYA.handle);
    const sam = await personIdOf(SAM.handle);

    const inB = await recall({ llm, chatId: chatB, memberIds: [maya, sam], query: "vegetarian food options", isGroup: true, now: now() });
    expect(inB.some((h) => h.kind === "fact")).toBe(false);
    expect(inB.some((h) => h.kind === "message" && h.content.includes("vegetarian"))).toBe(false);
  });

  it("keeps private chunks out of group recall and shows them only in that person's DM", async () => {
    t = await testAtlas({ features: [memoryFeature] });
    const chat = t.world.chat("priv-g", [MAYA, LEO]);
    await chat.addAtlas();
    const group = await chatIdOf("priv-g");
    const maya = await personIdOf(MAYA.handle);
    const leo = await personIdOf(LEO.handle);
    const base = { personId: maya, chatId: group, explicit: true, confidence: 0.9, sourceMessageId: null, observedAt: now(), retracted: false };
    await insertFacts([
      { ...base, key: "budget_comment", value: { kind: "ceiling", amountUsd: 600, about: null }, polarity: "neutral", visibility: "private", quote: "i can do 600 max" },
      { ...base, key: "dietary", value: { need: "vegetarian" }, polarity: "positive", visibility: "public", quote: "i'm vegetarian" },
    ]);
    expect(await embedTurn({ llm: t.llm, chatId: group, messageIds: [] })).toMatchObject({ windows: 0, facts: 2 });
    const stored = (await chunks()).filter((r) => r.kind === "fact");
    expect(stored.map((r) => [r.content, r.visibility])).toEqual([
      [`Maya set a budget ceiling — "i can do 600 max"`, "private"],
      [`Maya: vegetarian (dietary) — "i'm vegetarian"`, "public"],
    ]);

    // A 1:1 chat's own history is private to that person too.
    const dm = (await upsertChat("sim", "priv-dm-maya", false, now())).id;
    const dmMsg = await insertMessage({ chatId: dm, personId: maya, providerMessageId: "dm-1", direction: "inbound", kind: "text", text: "my budget ceiling is pretty firm this month", sentAt: now(), receivedAt: now() });
    expect(await embedTurn({ llm: t.llm, chatId: dm, messageIds: [dmMsg!.id] })).toMatchObject({ windows: 1, facts: 0 });
    expect((await chunks()).at(-1)).toMatchObject({ kind: "message", chat_id: dm, person_id: maya, visibility: "private" });

    const query = "maya budget ceiling vegetarian";
    const inGroup = await recall({ llm: t.llm, chatId: group, memberIds: [maya, leo], query, isGroup: true, now: now() });
    expect(inGroup.some((h) => h.visibility === "private")).toBe(false);

    const mayaDm = await recall({ llm: t.llm, chatId: dm, memberIds: [maya], query, isGroup: false, viewerId: maya, now: now() });
    expect(mayaDm.map((h) => h.content)).toEqual(["[Maya] my budget ceiling is pretty firm this month"]);

    // Someone else's 1:1 view never sees Maya's private chunks.
    const leoView = await recall({ llm: t.llm, chatId: group, memberIds: [maya, leo], query, isGroup: false, viewerId: leo, now: now() });
    expect(leoView.some((h) => h.visibility === "private")).toBe(false);
  });

  it("remembers a group decision once, recalled only in that chat", async () => {
    t = await testAtlas({ features: [memoryFeature] });
    const a = t.world.chat("dec-a", [MAYA, LEO]);
    const b = t.world.chat("dec-b", [MAYA, SAM]);
    await a.addAtlas();
    await b.addAtlas();
    const chatA = await chatIdOf("dec-a");
    const chatB = await chatIdOf("dec-b");
    const [maya, leo, sam] = [await personIdOf(MAYA.handle), await personIdOf(LEO.handle), await personIdOf(SAM.handle)];
    // What onTripLocked queues; a repeat (e.g. the hook firing twice) is stored once.
    for (let i = 0; i < 2; i++) await enqueueJob("memory.decision", { chatId: chatA, text: "the group locked Lisbon for nov 11–nov 14", at: now().toISOString(), tripId: 1 });
    await t.app.jobs.runDue();
    const decisions = (await chunks()).filter((r) => r.kind === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ chat_id: chatA, person_id: null, visibility: "public", content: "the group locked Lisbon for nov 11–nov 14", embedded: true });

    const query = "did the group pick lisbon";
    const inA = await recall({ llm: t.llm, chatId: chatA, memberIds: [maya, leo], query, isGroup: true, now: now() });
    expect(inA[0]).toMatchObject({ kind: "decision", content: "the group locked Lisbon for nov 11–nov 14" });
    const inB = await recall({ llm: t.llm, chatId: chatB, memberIds: [maya, sam], query, isGroup: true, now: now() });
    expect(inB.some((h) => h.kind === "decision")).toBe(false);
  });

  it("ranks the chunk that shares the query's words first", async () => {
    t = await testAtlas({ features: [memoryFeature] });
    const chat = t.chat("rank", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    await chat.say("maya", "the hostel near the beach had great reviews");
    await chat.say("leo", "flights to denver are cheap in march");
    await chat.say("priya", "i love hiking in the mountains");
    await t.app.jobs.runDue();
    const chatId = await chatIdOf("rank");
    const members = (await q<{ person_id: number }>(`SELECT person_id FROM chat_members WHERE chat_id = $1`, [chatId])).map((r) => r.person_id);
    const hits = await recall({ llm: t.llm, chatId, memberIds: members, query: "cheap flights to denver", isGroup: true, now: now() });
    expect(hits[0]!.content).toBe("[Leo] flights to denver are cheap in march");
    expect(hits[0]!.similarity).toBeGreaterThan(0.5);
    for (const h of hits.slice(1)) expect(h.score).toBeLessThan(hits[0]!.score);
    expect(hits.some((h) => h.content.includes("hiking"))).toBe(false); // no shared words: under the threshold
  });

  it("three weeks later still finds the old message, ranked a little below an equally similar fresh one", async () => {
    const clock = new OffsetClock();
    clock.set(new Date("2026-10-10T19:00:00Z"));
    setClock(clock);
    t = await testAtlas({ features: [memoryFeature] });
    const chat = t.chat("later", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    await chat.say("leo", "the ramen place in shibuya was incredible");
    await t.app.jobs.runDue();
    clock.advance(21 * DAY);
    await chat.say("leo", "the ramen place in shibuya was incredible");
    await t.app.jobs.runDue();
    const chatId = await chatIdOf("later");
    const members = (await q<{ person_id: number }>(`SELECT person_id FROM chat_members WHERE chat_id = $1`, [chatId])).map((r) => r.person_id);

    const hits = await recall({ llm: t.llm, chatId, memberIds: members, query: "ramen in shibuya", isGroup: true, now: now() });
    const same = hits.filter((h) => h.content === "[Leo] the ramen place in shibuya was incredible");
    expect(same).toHaveLength(2);
    const [fresh, old] = same[0]!.createdAt > same[1]!.createdAt ? [same[0]!, same[1]!] : [same[1]!, same[0]!];
    expect(now().getTime() - old.createdAt.getTime()).toBeGreaterThanOrEqual(21 * DAY);
    expect(old.similarity).toBeCloseTo(fresh.similarity, 6);
    expect(old.score).toBeLessThan(fresh.score);
    expect(old.score / fresh.score).toBeCloseTo(recencyFactor(21), 1);
    expect(hits[0]!.id).toBe(fresh.id);
  });

  it("puts recalled memories into the agent's situation and traces the retrieval", async () => {
    const clock = new OffsetClock();
    clock.set(new Date("2026-10-10T19:00:00Z"));
    setClock(clock);
    const llm = quietFake();
    t = await testAtlas({ llm, features: [memoryFeature] });
    const chat = t.chat("situ", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    expect(await chat.say("leo", "i went to lisbon last year and the food was unreal")).toEqual([]);
    await t.app.jobs.runDue();
    clock.advance(21 * DAY);
    // Push leo's line out of the 30 the agent can see, so only recall can bring it back.
    const situChat = await chatIdOf("situ");
    for (let i = 0; i < 31; i++) {
      await insertMessage({ chatId: situChat, personId: null, providerMessageId: `filler-${i}`, direction: "outbound", kind: "text", text: `filler line ${i}`, sentAt: now(), receivedAt: now() });
    }

    let prompt = "";
    llm.set("agent", (req) => {
      prompt = promptOf(req);
      return textResult("he said he went last year and the food was unreal");
    });
    const replies = await chat.say("maya", "atlas what did leo say about lisbon?");
    expect(replies.map((r) => r.text)).toEqual(["he said he went last year and the food was unreal"]);
    expect(prompt).toContain(`# ${MEMORY_SECTION_TITLE}\n(oct 10, message) [Leo] i went to lisbon last year and the food was unreal`);

    const trace = await q<{ model: string; decision: string; reason: string; turn_id: number }>(
      `SELECT model, decision, reason, turn_id FROM llm_traces WHERE role = 'memory' ORDER BY id DESC LIMIT 1`,
    );
    expect(trace[0]).toMatchObject({ model: "hash", decision: "1" });
    expect(trace[0]!.reason).toContain(`query "what did leo say about lisbon?"`);
    expect(trace[0]!.reason).toContain("message: [Leo] i went to lisbon last year");
  });

  it("leaves the section out when nothing relevant is remembered", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm, features: [memoryFeature] });
    const chat = t.chat("none", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    let prompt = "";
    llm.set("agent", (req) => {
      prompt = promptOf(req);
      return textResult("NO_REPLY");
    });
    await chat.say("maya", "atlas where should we go in november");
    expect(prompt).toContain("# new messages");
    expect(prompt).not.toContain(MEMORY_SECTION_TITLE);
  });

  it("lets the agent search memory with recall_memory", async () => {
    const clock = new OffsetClock();
    clock.set(new Date("2026-10-10T19:00:00Z"));
    setClock(clock);
    const llm = quietFake();
    t = await testAtlas({ llm, features: [memoryFeature] });
    const chat = t.chat("tool", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    await chat.say("leo", "i went to lisbon last year and the food was unreal");
    await t.app.jobs.runDue();

    let round = 0;
    let response: Record<string, unknown> | undefined;
    llm.set("agent", (req) => {
      if (round++ === 0) return callResult("recall_memory", { query: "leo lisbon" });
      const last = req.contents[req.contents.length - 1]!;
      response = (last.parts[0] as { functionResponse: { response: Record<string, unknown> } }).functionResponse.response;
      return textResult("leo said the food there was unreal");
    });
    const replies = await chat.say("maya", "atlas remind me what leo thought of lisbon");
    expect(replies.map((r) => r.text)).toEqual(["leo said the food there was unreal"]);
    expect(response).toMatchObject({ ok: true });
    const hits = (response!.data as { hits: { when: string; kind: string; content: string; score: number }[] }).hits;
    expect(hits[0]).toMatchObject({ when: "oct 10", kind: "message", content: "[Leo] i went to lisbon last year and the food was unreal" });
    expect(hits[0]!.score).toBeGreaterThan(0.15);
  });
});
