// The outbox under send failures: permanent provider errors fail fast (and never block other chats),
// transient ones retry with backoff until they go out, and rows left behind too long are skipped.
import type { Space } from "spectrum-ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, setConfig } from "../../src/config.ts";
import { OffsetClock, now, setClock, systemClock } from "../../src/clock.ts";
import { q } from "../../src/db/pool.ts";
import { upsertChat, type ChatRow } from "../../src/db/repos/core.ts";
import { JobRunner } from "../../src/pipeline/jobs.ts";
import { OUTBOX_STALE_MS, Pipeline } from "../../src/pipeline/pipeline.ts";
import { LinqApiError } from "../../src/transport/linq/api.ts";
import { dbAvailable, freshDb } from "../helpers/db.ts";

const describeDb = dbAvailable ? describe : describe.skip;
const NO_PERMISSION = '{"error":{"code":2006,"message":"You do not have permission to send from this phone number"}}';

describeDb("outbox under send failures", () => {
  let drop: (() => Promise<void>) | undefined;
  let clock: OffsetClock;
  /** What each chat's sends do next: "ok", "denied" (403 code 2006) or "flaky" (network error). */
  const behavior = new Map<string, () => "ok" | "denied" | "flaky">();
  /** Chats sends went to, in order (what was sent is read back from the history log). */
  const sent: string[] = [];

  const spaceFor = (chat: ChatRow): Space =>
    ({
      id: chat.provider_chat_id,
      send: async (content: unknown) => {
        const mode = behavior.get(chat.provider_chat_id)?.() ?? "ok";
        if (mode === "denied") throw new LinqApiError(`/chats/${chat.provider_chat_id}/messages`, 403, NO_PERMISSION);
        if (mode === "flaky") throw new Error("fetch failed");
        sent.push(chat.provider_chat_id);
        return { id: `p${sent.length}`, content };
      },
      startTyping: async () => {},
      stopTyping: async () => {},
      getMembers: async () => [],
    }) as unknown as Space;

  const pipeline = () => new Pipeline({ handler: async () => ({ actions: [], route: "test" }), resolveSpace: async (c) => spaceFor(c), pacing: () => 0, typing: false });
  const outbound = async () => (await q<{ text: string }>(`SELECT text FROM messages WHERE direction = 'outbound' ORDER BY id`)).map((r) => r.text);
  const statuses = async (chatId: number) => (await q<{ status: string }>(`SELECT status FROM outbox WHERE chat_id = $1 ORDER BY id`, [chatId])).map((r) => r.status);

  beforeEach(async () => {
    const db = await freshDb();
    drop = db.drop;
    setConfig(loadConfig({ ...process.env, IMESSAGE_MODE: "sim", LLM_MODE: "fake", DATABASE_URL: db.url }));
    clock = new OffsetClock();
    setClock(clock);
    behavior.clear();
    sent.length = 0;
  });
  afterEach(async () => {
    setClock(systemClock);
    await drop?.();
  });

  it("a 403 'no permission to send' fails the chat's rows at once and never blocks another chat", async () => {
    const bad = await upsertChat("sim", "bad", true, now());
    const good = await upsertChat("sim", "good", true, now());
    behavior.set("bad", () => "denied");
    const p = pipeline();
    await p.enqueue(bad.id, "t1", [
      { type: "say", text: "one" },
      { type: "say", text: "two" },
    ]);
    await p.enqueue(good.id, "t2", [{ type: "say", text: "hello good chat" }]);
    const result = await p.flush(bad.id);
    expect(result).toMatchObject({ bubbles: 0, failed: 2 });
    expect(await statuses(bad.id)).toEqual(["failed", "failed"]);
    // No retry is queued for a permanent error.
    expect(await q(`SELECT 1 FROM jobs WHERE kind = 'outbox.flush'`)).toHaveLength(0);
    expect(await p.flush(good.id)).toMatchObject({ bubbles: 1, failed: 0 });
    expect(sent).toEqual(["good"]);
    expect(await outbound()).toEqual(["hello good chat"]);
  });

  it("a transient error retries with backoff until the message goes out, keeping order", async () => {
    const chat = await upsertChat("sim", "flaky", true, now());
    let calls = 0;
    behavior.set("flaky", () => (++calls <= 2 ? "flaky" : "ok"));
    const p = pipeline();
    const jobs = new JobRunner().register("outbox.flush", async (payload) => void (await p.flush(Number(payload.chatId))));
    await p.enqueue(chat.id, "t1", [
      { type: "say", text: "first" },
      { type: "say", text: "second" },
    ]);
    expect(await p.flush(chat.id)).toMatchObject({ bubbles: 0, failed: 1 });
    expect(await statuses(chat.id)).toEqual(["pending", "pending"]);
    // Each failure queues its own retry (the second must not be swallowed by the first's job).
    for (let i = 0; i < 2; i++) {
      clock.advance(70_000);
      expect(await jobs.runDue()).toBe(1);
    }
    expect(await outbound()).toEqual(["first", "second"]);
    expect(await statuses(chat.id)).toEqual(["sent", "sent"]);
  });

  it("gives up on a message after every retry fails and lets the rest of the chat go out", async () => {
    const chat = await upsertChat("sim", "stuck", true, now());
    const p = pipeline();
    await p.enqueue(chat.id, "t1", [
      { type: "say", text: "never" },
      { type: "say", text: "after" },
    ]);
    await q(`UPDATE outbox SET attempts = 4 WHERE client_guid = 't1-0'`);
    let first = true;
    behavior.set("stuck", () => (first ? ((first = false), "flaky") : "ok"));
    await p.flush(chat.id);
    expect(await statuses(chat.id)).toEqual(["failed", "sent"]);
    expect(await outbound()).toEqual(["after"]);
  });

  it("skips a row left pending too long instead of sending a stale reply", async () => {
    const chat = await upsertChat("sim", "late", true, now());
    const p = pipeline();
    await p.enqueue(chat.id, "t1", [{ type: "say", text: "an answer from an hour ago" }]);
    clock.advance(OUTBOX_STALE_MS + 60_000);
    await p.enqueue(chat.id, "t2", [{ type: "say", text: "fresh" }]);
    await p.flush(chat.id);
    expect(await statuses(chat.id)).toEqual(["skipped", "sent"]);
    expect(await outbound()).toEqual(["fresh"]);
  });
});
