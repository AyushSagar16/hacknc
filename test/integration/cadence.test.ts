// Message cadence (typing indicator + paced bubbles), the shorter quiet window for messages that
// name Atlas, and outbound bookkeeping that never re-sends a bubble.
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, setConfig } from "../../src/config.ts";
import { one, q } from "../../src/db/pool.ts";
import { Pipeline, namesAgentComplete, pacingFromConfig, type PipelineOptions, type TurnHandler } from "../../src/pipeline/pipeline.ts";
import type { Action } from "../../src/transport/outbound.ts";
import { createTransport } from "../../src/transport/modes.ts";
import { SimWorld, simMembers, LINQ_LIKE, type SimChat } from "../../src/transport/sim/platform.ts";
import { dbAvailable, freshDb } from "../helpers/db.ts";

const describeDb = dbAvailable ? describe : describe.skip;

describe("pacing and addressing helpers", () => {
  it("scales the pause with length, clamps it, and caps the first bubble", () => {
    const cfg = loadConfig({ PACING: "on" });
    const pace = pacingFromConfig(cfg);
    expect(pace("ok", 1)).toBe(600); // floor
    expect(pace("x".repeat(40), 1)).toBe(1_400); // 400 + 25·40
    expect(pace("x".repeat(400), 1)).toBe(2_500); // ceiling
    expect(pace("x".repeat(400), 0)).toBe(1_000); // first bubble: thinking already took time
    expect(pacingFromConfig(loadConfig({ PACING: "off" }))("x".repeat(400), 1)).toBe(0);
  });

  it("treats only complete requests that name Atlas as urgent", () => {
    expect(namesAgentComplete("atlas what's our budget?", "Atlas")).toBe(true);
    expect(namesAgentComplete("@atlas give us some options", "Atlas")).toBe(true);
    expect(namesAgentComplete("ok atlas, when?", "Atlas")).toBe(true);
    expect(namesAgentComplete("atlas", "Atlas")).toBe(false);
    expect(namesAgentComplete("hey atlas", "Atlas")).toBe(false);
    expect(namesAgentComplete("we should look at flights to lisbon", "Atlas")).toBe(false);
    expect(namesAgentComplete("atlasian stuff is cool right", "Atlas")).toBe(false);
  });
});

describeDb("cadence on the simulator", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function boot(handler: TurnHandler, opts: Partial<PipelineOptions> = {}) {
    const { drop } = await freshDb();
    const cfg = loadConfig({ ...process.env, IMESSAGE_MODE: "sim" });
    setConfig(cfg);
    const world = new SimWorld();
    const transport = await createTransport(cfg, { world });
    const typing: { on: boolean; atlasBubbles: number }[] = [];
    let chatRef: SimChat | undefined;
    const pipeline = new Pipeline({
      handler,
      resolveSpace: (chat) => transport.resolveSpace(chat),
      debounceMs: 30,
      maxWaitMs: 500,
      pacing: () => 0,
      typing: async (_space, on) => {
        typing.push({ on, atlasBubbles: chatRef?.transcript.filter((e) => e.from === "atlas").length ?? 0 });
      },
      ...opts,
    });
    world.waitIdle = (chatId) => pipeline.waitIdle("sim", chatId);
    world.expect = (chatId) => pipeline.expect("sim", chatId);
    const loop = transport.run((space, message) => pipeline.ingest(space, message));
    close = async () => {
      await transport.stop();
      await loop.catch(() => {});
      await drop();
    };
    const chat = (id: string) => (chatRef = world.chat(id, simMembers(["maya", "leo", "priya"]), LINQ_LIKE));
    return { pipeline, world, typing, chat };
  }

  it("types while thinking, between paced bubbles, and not before tapbacks or polls", async () => {
    const paced: string[] = [];
    const { typing, chat } = await boot(
      async (input) => {
        input.typing?.();
        await new Promise((r) => setTimeout(r, 20));
        const actions: Action[] = [
          { type: "say", text: "here are three options" },
          { type: "say", text: "1. lisbon" },
          { type: "poll", title: "where to?", options: ["lisbon", "porto"] },
        ];
        return { route: "test", actions };
      },
      {
        pacing: (text, i) => {
          paced.push(`${i}:${text}`);
          return 40;
        },
      },
    );
    const replies = await chat("c1").say("maya", "atlas options please");
    expect(replies.map((r) => r.kind)).toEqual(["text", "text", "poll"]);
    // The poll never asks for a pause; the first bubble's pause is mostly covered by thinking time.
    expect(paced).toEqual(["0:here are three options", "1:1. lisbon"]);
    // Typing goes on before the first bubble (from the brain) and again before the second.
    expect(typing).toEqual([
      { on: true, atlasBubbles: 0 },
      { on: true, atlasBubbles: 1 },
    ]);
  });

  it("clears typing when the turn ends silent", async () => {
    const { typing, chat } = await boot(async (input) => {
      input.typing?.();
      return { route: "silent", actions: [] };
    });
    const replies = await chat("c2").say("maya", "atlas are you there?");
    expect(replies).toEqual([]);
    expect(typing.map((t) => t.on)).toEqual([true, false]);
  });

  it("takes the thinking time off the first bubble's pause", async () => {
    let returnedAt = 0;
    const { chat } = await boot(
      async (input) => {
        input.typing?.();
        await new Promise((r) => setTimeout(r, 300));
        returnedAt = Date.now();
        return { route: "test", actions: [{ type: "say", text: "on it" }] };
      },
      { pacing: () => 300 },
    );
    await chat("c3").say("maya", "atlas quick question about dates");
    const sentAt = (await one<{ sent_at: Date }>(`SELECT sent_at FROM outbox ORDER BY id LIMIT 1`))!.sent_at.getTime();
    expect(sentAt - returnedAt).toBeLessThan(200);
  });

  it("answers a complete message that names atlas after the shorter quiet window", async () => {
    const started: { text: string; at: number }[] = [];
    const { chat } = await boot(
      async (input) => {
        started.push({ text: input.batch.map((m) => m.text).join(" | "), at: Date.now() });
        return { route: "test", actions: [] };
      },
      { debounceMs: 600, addressedDebounceMs: 40, maxWaitMs: 2_000 },
    );
    const c = chat("c4");
    let t0 = Date.now();
    await c.say("maya", "atlas what's our budget?");
    const urgent = started[0]!.at - t0;
    t0 = Date.now();
    await c.say("maya", "lol same");
    const normal = started[1]!.at - t0;
    expect(urgent).toBeLessThan(400);
    expect(normal).toBeGreaterThanOrEqual(550);
  });

  it("keeps a follow-up requested during a turn that only replays stale messages, drops it after a real answer", async () => {
    const turns: { batch: string[]; nudge?: string }[] = [];
    let release!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((r) => (started = r));
    const gate = new Promise<void>((r) => (release = r));
    const { pipeline, world } = await boot(
      async (input) => {
        turns.push({ batch: input.batch.map((m) => m.text), nudge: input.nudge });
        if (turns.length === 1) {
          started();
          await gate;
        }
        return { route: "test", actions: [] };
      },
      { staleAfterSeconds: 0 }, // every delivery counts as a stale replay: extraction only
    );
    const c = world.chat("c6", simMembers(["maya", "leo"]), LINQ_LIKE);
    await c.say("maya", "atlas when do we leave?", { wait: false });
    await firstStarted;
    const chatId = (await one<{ id: number }>(`SELECT id FROM chats WHERE provider_chat_id = 'c6'`))!.id;
    await pipeline.nudge(chatId, "came back online");
    release();
    await world.waitIdle("c6");
    expect(turns).toEqual([{ batch: ["atlas when do we leave?"], nudge: undefined }, { batch: [], nudge: "came back online" }]);
  });

  it("logs a sent bubble whose turn row is gone, without sending it again", async () => {
    const { pipeline, world } = await boot(async () => ({ route: "test", actions: [] }));
    const c = world.chat("c5", simMembers(["maya", "leo"]), LINQ_LIKE);
    await c.say("maya", "hi");
    const chatId = (await one<{ id: number }>(`SELECT id FROM chats WHERE provider_chat_id = 'c5'`))!.id;
    // Reproduce the state behind the old messages_turn_id_fkey failures: an outbox row pointing at
    // a turn that no longer exists.
    await q(`ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_turn_id_fkey`);
    const turn = (await one<{ id: number }>(`INSERT INTO turns (chat_id, started_at) VALUES ($1, now()) RETURNING id`, [chatId]))!.id;
    await pipeline.enqueue(chatId, "gone", [{ type: "say", text: "myrtle beach wins" }], turn);
    await q(`DELETE FROM turns WHERE id = $1`, [turn]);
    await pipeline.flush(chatId);
    await pipeline.flush(chatId);
    expect(c.transcript.filter((e) => e.from === "atlas").map((e) => e.text)).toEqual(["myrtle beach wins"]);
    const out = await q<{ status: string }>(`SELECT status FROM outbox WHERE client_guid = 'gone-0'`);
    expect(out).toEqual([{ status: "sent" }]);
    const logged = await q<{ turn_id: number | null }>(`SELECT turn_id FROM messages WHERE direction = 'outbound' AND text = 'myrtle beach wins'`);
    expect(logged).toEqual([{ turn_id: null }]);
  });
});
