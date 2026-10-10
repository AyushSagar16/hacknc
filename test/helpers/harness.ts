// Boots the real transport (sim mode) and pipeline against a disposable database.
import { loadConfig, setConfig } from "../../src/config.ts";
import { Pipeline, type TurnHandler } from "../../src/pipeline/pipeline.ts";
import { createTransport, type Transport } from "../../src/transport/modes.ts";
import { SimWorld, simMembers, type SimCapabilities, LINQ_LIKE } from "../../src/transport/sim/platform.ts";
import { freshDb } from "./db.ts";

export interface Harness {
  world: SimWorld;
  pipeline: Pipeline;
  transport: Transport;
  chat(id: string, names: string[], caps?: SimCapabilities): ReturnType<SimWorld["chat"]>;
  close(): Promise<void>;
}

export async function harness(handler: TurnHandler, opts: { debounceMs?: number; maxWaitMs?: number } = {}): Promise<Harness> {
  const { drop } = await freshDb();
  const cfg = loadConfig({ ...process.env, IMESSAGE_MODE: "sim" });
  setConfig(cfg);
  const world = new SimWorld();
  const transport = await createTransport(cfg, { world });
  const pipeline = new Pipeline({
    handler,
    resolveSpace: (chat) => transport.resolveSpace(chat),
    debounceMs: opts.debounceMs ?? 30,
    maxWaitMs: opts.maxWaitMs ?? 500,
    pacing: () => 0,
  });
  world.waitIdle = (chatId) => pipeline.waitIdle("sim", chatId);
  world.expect = (chatId) => pipeline.expect("sim", chatId);
  const loop = transport.run((space, message) => pipeline.ingest(space, message));
  return {
    world,
    pipeline,
    transport,
    chat: (id, names, caps = LINQ_LIKE) => world.chat(id, simMembers(names), caps),
    close: async () => {
      await transport.stop();
      await loop.catch(() => {});
      await drop();
    },
  };
}
