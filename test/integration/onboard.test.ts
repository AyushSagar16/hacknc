// "atlas onboard": a full reset of one chat, then the intro again; other chats are untouched.
import { afterEach, describe, expect, it } from "vitest";
import { one, q } from "../../src/db/pool.ts";
import { findChat } from "../../src/db/repos/core.ts";
import { dbAvailable } from "../helpers/db.ts";
import { pastIntro, quietFake, testAtlas, type TestAtlas } from "../helpers/atlas.ts";

const describeDb = dbAvailable ? describe : describe.skip;
const AT = new Date("2026-10-10T18:00:00Z");

const n = async (sql: string, params: unknown[] = []) => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params))!.n;

/** A trip with a poll, a vote, an expense, a budget, a fact and a recall chunk, for the chat's focused trip. */
async function seed(chatId: number, personId: number): Promise<number> {
  const trip = (await one<{ id: number }>(`SELECT focus_trip_id AS id FROM chats WHERE id = $1`, [chatId]))!.id;
  const msg = (await one<{ id: number }>(`SELECT id FROM messages WHERE chat_id = $1 AND direction = 'inbound' ORDER BY id LIMIT 1`, [chatId]))!.id;
  const poll = (await one<{ id: number }>(
    `INSERT INTO polls (trip_id, chat_id, title, options, created_at) VALUES ($1,$2,'where?','[]'::jsonb,$3) RETURNING id`,
    [trip, chatId, AT],
  ))!.id;
  await q(`INSERT INTO votes (poll_id, person_id, option_idx, source, voted_at) VALUES ($1,$2,0,'text',$3)`, [poll, personId, AT]);
  await q(`INSERT INTO expenses (trip_id, payer_id, amount_cents, description, shares, source_message_id, idempotency_key, spent_on, created_at) VALUES ($1,$2,5000,'dinner','{}'::jsonb,$3,$4,'2026-10-10',$5)`, [trip, personId, msg, `k${chatId}`, AT]);
  await q(`INSERT INTO budgets (person_id, trip_id, adjusted_cents, updated_at) VALUES ($1,$2,60000,$3)`, [personId, trip, AT]);
  await q(`INSERT INTO facts (person_id, chat_id, trip_id, key, value, confidence, source_message_id, observed_at) VALUES ($1,$2,$3,'destination','"lisbon"'::jsonb,0.9,$4,$5)`, [personId, chatId, trip, msg, AT]);
  await q(`INSERT INTO memory_chunks (chat_id, person_id, kind, content, created_at) VALUES ($1,$2,'fact','likes lisbon',$3)`, [chatId, personId, AT]);
  await q(`INSERT INTO jobs (kind, due_at, payload, created_at) VALUES ('weather.check',$1,$2::jsonb,$1)`, [AT, JSON.stringify({ tripId: trip, chatId })]);
  await q(`UPDATE trips SET destination_name = 'Lisbon' WHERE id = $1`, [trip]);
  return trip;
}

const counts = async (chatId: number, tripId: number) => ({
  messages: await n(`messages WHERE chat_id = $1`, [chatId]),
  polls: await n(`polls WHERE chat_id = $1`, [chatId]),
  votes: await n(`votes WHERE poll_id IN (SELECT id FROM polls WHERE trip_id = $1)`, [tripId]),
  expenses: await n(`expenses WHERE trip_id = $1`, [tripId]),
  budgets: await n(`budgets WHERE trip_id = $1`, [tripId]),
  facts: await n(`facts WHERE chat_id = $1`, [chatId]),
  chunks: await n(`memory_chunks WHERE chat_id = $1`, [chatId]),
  jobs: await n(`jobs WHERE kind = 'weather.check' AND payload->>'chatId' = $1::text AND done_at IS NULL`, [chatId]),
  trips: await n(`trips WHERE id = $1`, [tripId]),
});

describeDb("atlas onboard", () => {
  let t: TestAtlas | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it("wipes only this chat and runs the intro again", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const a = t.chat("ob-a", ["maya", "leo", "priya"]);
    const b = t.chat("ob-b", ["maya", "sam", "kai"]);
    await pastIntro(a);
    await b.addAtlas();
    for (const who of ["maya", "sam", "kai"]) await b.say(who, "ok");
    const chatA = (await findChat("sim", "ob-a"))!;
    const chatB = (await findChat("sim", "ob-b"))!;
    const person = (await one<{ id: number }>(`SELECT person_id AS id FROM chat_members WHERE chat_id = $1 LIMIT 1`, [chatA.id]))!.id;
    const tripA = await seed(chatA.id, person);
    const tripB = await seed(chatB.id, person);
    await q(`UPDATE chats SET quiet_mode = true WHERE id = $1`, [chatA.id]);
    const before = await counts(chatB.id, tripB);
    expect(before.facts).toBe(1);
    expect((await counts(chatA.id, tripA)).messages).toBeGreaterThan(3);
    const llmCalls = llm.calls.length;

    const replies = await a.say("maya", "atlas onboard");

    expect(replies[0]!.text).toMatch(/fresh start/);
    expect(replies.map((r) => r.text).join("\n")).toMatch(/hi, i'm atlas, your trip and financial planner/);
    expect(llm.calls.slice(llmCalls).filter((c: { role: string }) => c.role !== "extract")).toEqual([]); // no gate, no agent
    const after = await counts(chatA.id, tripA);
    expect(after).toMatchObject({ polls: 0, votes: 0, expenses: 0, budgets: 0, facts: 0, chunks: 0, jobs: 0, trips: 0 });
    expect(after.messages).toBeLessThanOrEqual(1 + 4); // the command itself + the fresh intro
    const row = (await findChat("sim", "ob-a"))!;
    expect(row.quiet_mode).toBe(false);
    expect(row.intro_sent_at).not.toBeNull();
    const fresh = (await one<{ id: number; destination_name: string | null }>(`SELECT t.id, t.destination_name FROM chats c JOIN trips t ON t.id = c.focus_trip_id WHERE c.id = $1`, [chatA.id]))!;
    expect(fresh.id).not.toBe(tripA);
    expect(fresh.destination_name).toBeNull();
    expect(await n(`chat_members WHERE chat_id = $1`, [chatA.id])).toBe(3);

    // The other chat is exactly as it was.
    expect(await counts(chatB.id, tripB)).toEqual(before);
    expect((await findChat("sim", "ob-b"))!.intro_sent_at).not.toBeNull();
    expect((await one<{ destination_name: string }>(`SELECT destination_name FROM trips WHERE id = $1`, [tripB]))!.destination_name).toBe("Lisbon");
  });

  it("in a private chat it says to use a group and wipes nothing", async () => {
    t = await testAtlas({ llm: quietFake() });
    const dm = t.chat("ob-dm", ["maya"]);
    await dm.addAtlas();
    const chat = (await findChat("sim", "ob-dm"))!;
    const msgs = await n(`messages WHERE chat_id = $1`, [chat.id]);
    expect(chat.is_group).toBe(false);
    const replies = await dm.say("maya", "atlas onboard");
    expect(replies.map((r) => r.text).join(" ")).toMatch(/works in group chats/);
    expect(await n(`messages WHERE chat_id = $1`, [chat.id])).toBeGreaterThan(msgs);
  });
});
