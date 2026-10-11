// Boots the whole of Atlas (sim line, real pipeline + brain + features) on a disposable database.
import { loadConfig, setConfig } from "../../src/config.ts";
import { startAtlas, type AtlasApp } from "../../src/app.ts";
import type { Feature } from "../../src/agent/feature.ts";
import { FakeLlm, jsonResult, textResult, type Llm } from "../../src/agent/llm.ts";
import { SimWorld, simMembers, LINQ_LIKE, type SimCapabilities } from "../../src/transport/sim/platform.ts";
import { freshDb } from "./db.ts";
import { now } from "../../src/clock.ts";
import { one } from "../../src/db/pool.ts";
import { findChat } from "../../src/db/repos/core.ts";
import { connectSecret, handleConnectCallback } from "../../src/agent/features/connect.ts";
import { signBody, signToken } from "../../src/connect/token.ts";

export interface TestAtlas {
  app: AtlasApp;
  world: SimWorld;
  llm: Llm;
  chat(id: string, names: string[], caps?: SimCapabilities): ReturnType<SimWorld["chat"]>;
  close(): Promise<void>;
}

/** A FakeLlm that extracts nothing and keeps the gate silent unless a test overrides a role. */
export function quietFake(): FakeLlm {
  return new FakeLlm({
    extract: () => jsonResult({ facts: [], tensions: [] }),
    gate: () => jsonResult({ decision: "NO_REPLY", reason: "banter" }),
    agent: () => textResult("NO_REPLY"),
  });
}

export async function testAtlas(opts: { llm?: Llm; env?: Record<string, string>; features?: Feature[] } = {}): Promise<TestAtlas> {
  const { drop } = await freshDb();
  const cfg = loadConfig({ ...process.env, IMESSAGE_MODE: "sim", LLM_MODE: "fake", ...opts.env });
  setConfig(cfg);
  const world = new SimWorld();
  const llm = opts.llm ?? quietFake();
  const app = await startAtlas({ cfg, llm, world, debounceMs: 25, maxWaitMs: 400, pacing: () => 0, startJobs: false, extraFeatures: opts.features, names: (h) => world.nameOf(h) });
  return {
    app,
    world,
    llm,
    chat: (id, names, caps = LINQ_LIKE) => {
      const c = world.chat(id, simMembers(names), caps);
      return c;
    },
    close: async () => {
      await app.stop();
      await drop();
    },
  };
}

/** Atlas's intro ends with a question; a few replies close it so later messages count as untagged. */
export async function pastIntro(chat: ReturnType<SimWorld["chat"]>): Promise<void> {
  await chat.addAtlas();
  for (const [who, text] of [["maya", "ok"], ["leo", "alright"], ["priya", "cool"]] as const) await chat.say(who, text);
}

/** Everyone in the chat taps Connect on their bank-connect page (the signed callback), then jobs run. */
export async function connectAll(t: TestAtlas, chat: ReturnType<SimWorld["chat"]>): Promise<void> {
  const chatRow = (await findChat("sim", chat.id))!;
  const secret = connectSecret(t.app.cfg);
  for (const m of chat.members) {
    const person = (await one<{ id: number }>(`SELECT id FROM people WHERE handle = $1`, [m.handle]))!;
    const body = JSON.stringify({ token: signToken({ p: person.id, c: chatRow.id, n: m.name, cb: "http://127.0.0.1" }, secret, now().getTime()) });
    const res = await handleConnectCallback(body, signBody(body, secret), { cfg: t.app.cfg });
    if (res.status !== 200) throw new Error(`connect failed: ${JSON.stringify(res.json)}`);
  }
  for (let i = 0; i < 3 && (await t.app.jobs.runDue()) > 0; i++) await t.world.waitIdle(chat.id);
}
