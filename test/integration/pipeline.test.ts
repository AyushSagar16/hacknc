import { afterEach, describe, expect, it } from "vitest";
import { q } from "../../src/db/pool.ts";
import type { TurnHandler, TurnInput } from "../../src/pipeline/pipeline.ts";
import { LOCAL_LIKE } from "../../src/transport/sim/platform.ts";
import { dbAvailable } from "../helpers/db.ts";
import { harness, type Harness } from "../helpers/harness.ts";

const describeDb = dbAvailable ? describe : describe.skip;

describeDb("pipeline on the simulator", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const echo: TurnHandler = async ({ batch }) => ({
    route: "test",
    actions: [{ type: "say", text: `echo: ${batch.map((m) => m.text).join(" | ")}` }],
  });

  it("answers a message through the real Spectrum loop", async () => {
    h = await harness(echo);
    const chat = h.chat("c1", ["maya", "leo", "priya"]);
    const replies = await chat.say("maya", "hi atlas");
    expect(replies.map((r) => r.text)).toEqual(["echo: hi atlas"]);
    const rows = await q<{ direction: string; text: string }>(`SELECT direction, text FROM messages ORDER BY id`);
    expect(rows).toEqual([
      { direction: "inbound", text: "hi atlas" },
      { direction: "outbound", text: "echo: hi atlas" },
    ]);
  });

  it("debounces a burst into one turn", async () => {
    const batches: string[][] = [];
    h = await harness(async (input) => {
      batches.push(input.batch.map((m) => m.text));
      return echo(input);
    }, { debounceMs: 80 });
    const chat = h.chat("c2", ["maya", "leo", "priya"]);
    await chat.say("maya", "hey", { wait: false });
    await chat.say("maya", "wait", { wait: false });
    await chat.say("maya", "do flights to lisbon exist in march", { wait: false });
    await h.world.waitIdle("c2");
    expect(batches).toEqual([["hey", "wait", "do flights to lisbon exist in march"]]);
  });

  it("drops a redelivered message", async () => {
    let turns = 0;
    h = await harness(async (input) => {
      turns += 1;
      return echo(input);
    });
    const chat = h.chat("c3", ["maya", "leo", "priya"]);
    await chat.say("maya", "hello");
    // Redeliver the same provider message id.
    h.world.expect("c3");
    h.world.queue.push({ id: chat.transcript[0]!.id, content: { type: "text", text: "hello" }, direction: "inbound", sender: { id: chat.members[0]!.handle }, space: { id: "c3" }, timestamp: new Date() });
    await h.world.waitIdle("c3");
    expect(turns).toBe(1);
    const [{ count }] = await q<{ count: number }>(`SELECT count(*)::int AS count FROM messages WHERE direction='inbound'`);
    expect(count).toBe(1);
  });

  it("cancels an in-flight turn when a new message lands and carries its messages forward", async () => {
    const seen: string[][] = [];
    h = await harness(async (input: TurnInput) => {
      seen.push(input.batch.map((m) => m.text));
      if (seen.length === 1) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 400);
          input.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
      }
      return echo(input);
    });
    const chat = h.chat("c4", ["maya", "leo", "priya"]);
    await chat.say("maya", "where should we go", { wait: false });
    await new Promise((r) => setTimeout(r, 120));
    await chat.say("leo", "somewhere warm", { wait: false });
    await h.world.waitIdle("c4");
    expect(seen).toEqual([["where should we go"], ["where should we go", "somewhere warm"]]);
    expect(chat.atlasSince(undefined).map((e) => e.text)).toEqual(["echo: where should we go | somewhere warm"]);
    const statuses = await q<{ status: string }>(`SELECT status FROM turns ORDER BY id`);
    expect(statuses.map((s) => s.status)).toEqual(["cancelled", "done"]);
  });

  it("does not cancel once a turn has started a money side effect", async () => {
    let calls = 0;
    h = await harness(async (input) => {
      calls += 1;
      if (calls === 1) {
        await input.nonCancellable();
        await new Promise((r) => setTimeout(r, 200));
      }
      return echo(input);
    });
    const chat = h.chat("c5", ["maya", "leo", "priya"]);
    await chat.say("maya", "i paid 64 for dinner", { wait: false });
    await new Promise((r) => setTimeout(r, 80));
    await chat.say("leo", "nice", { wait: false });
    await h.world.waitIdle("c5");
    expect(chat.atlasSince(undefined).map((e) => e.text)).toEqual(["echo: i paid 64 for dinner", "echo: nice"]);
  });

  it("falls back to text polls and text acks on a line without polls or tapbacks", async () => {
    h = await harness(async ({ batch }) => ({
      route: "test",
      actions: [
        { type: "react", targetId: batch[0]!.provider_message_id, tapback: "like", fallbackText: "got it" },
        { type: "poll", title: "where to?", options: ["Lisbon", "San Juan", "Asheville"] },
        { type: "say", text: "threaded", replyTo: batch[0]!.provider_message_id },
      ],
    }));
    const chat = h.chat("c6", ["maya", "leo", "priya"], LOCAL_LIKE);
    const replies = await chat.say("maya", "let's vote");
    expect(replies.map((r) => r.text)).toEqual([
      "got it",
      "where to?\nreply with a number or tap 👍 on your pick",
      "1. Lisbon",
      "2. San Juan",
      "3. Asheville",
      "threaded",
    ]);
    const rendered = await q<{ rendered_as: string }>(`SELECT rendered_as FROM outbox ORDER BY id`);
    expect(rendered.map((r) => r.rendered_as)).toEqual(["fallback", "fallback", "fallback"]);
  });

  it("uses native polls, tapbacks and threaded replies where the line has them", async () => {
    h = await harness(async ({ batch }) => ({
      route: "test",
      actions: [
        { type: "react", targetId: batch[0]!.provider_message_id, tapback: "like" },
        { type: "poll", title: "where to?", options: ["Lisbon", "San Juan"] },
        { type: "say", text: "threaded", replyTo: batch[0]!.provider_message_id },
      ],
    }));
    const chat = h.chat("c7", ["maya", "leo", "priya"]);
    const replies = await chat.say("maya", "let's vote");
    expect(replies.map((r) => r.kind)).toEqual(["reaction", "poll", "text"]);
    expect(replies[2]!.replyTo).toBe(chat.transcript[0]!.id);
  });

  it("turns Atlas being added into a membership message and registers everyone", async () => {
    const kinds: string[] = [];
    h = await harness(async ({ batch }) => {
      kinds.push(...batch.map((m) => m.kind));
      return { route: "test", actions: [{ type: "say", text: "hi, i'm atlas" }] };
    });
    const chat = h.chat("c8", ["maya", "leo", "priya"]);
    const replies = await chat.addAtlas("maya");
    expect(kinds).toEqual(["membership"]);
    expect(replies.map((r) => r.text)).toEqual(["hi, i'm atlas"]);
    const [{ count }] = await q<{ count: number }>(`SELECT count(*)::int AS count FROM chat_members WHERE active`);
    expect(count).toBe(3);
  });
});
