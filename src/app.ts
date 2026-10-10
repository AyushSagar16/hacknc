// Composition root: config → database → LLM → features → brain → pipeline → transport.
// The live process (src/index.ts), the simulator (scripts/sim.ts) and tests all start here.
import type { Config } from "./config.ts";
import { childLog } from "./log.ts";
import { migrate } from "./db/migrate.ts";
import { createBrain } from "./agent/brain.ts";
import type { AppServices, Feature } from "./agent/feature.ts";
import { planningFeature } from "./agent/features/planning.ts";
import { budgetsFeature } from "./agent/features/budgets.ts";
import { proposalsFeature } from "./agent/features/proposals.ts";
import { moneyFeature } from "./agent/features/money.ts";
import { weatherFeature } from "./agent/features/weather.ts";
import { createLlm, type Llm } from "./agent/llm.ts";
import { JobRunner, pruneOld } from "./pipeline/jobs.ts";
import { Pipeline } from "./pipeline/pipeline.ts";
import { createTransport, type Transport } from "./transport/modes.ts";
import type { SimWorld } from "./transport/sim/platform.ts";

export interface AtlasApp {
  cfg: Config;
  llm: Llm;
  services: AppServices;
  transport: Transport;
  pipeline: Pipeline;
  jobs: JobRunner;
  features: Feature[];
  /** Resolves when the inbound loop ends (after stop()). */
  done: Promise<void>;
  stop(): Promise<void>;
}

export interface AppOptions {
  cfg: Config;
  llm?: Llm;
  world?: SimWorld;
  debounceMs?: number;
  maxWaitMs?: number;
  pacing?: (text: string, index: number) => number;
  /** Start the background job poller (off in tests, which run jobs explicitly). */
  startJobs?: boolean;
  names?: (handle: string) => string | undefined;
  extraFeatures?: Feature[];
}

export async function startAtlas(opts: AppOptions): Promise<AtlasApp> {
  const { cfg } = opts;
  const log = childLog({ component: "app" });
  await migrate();
  const llm = opts.llm ?? createLlm({ mode: cfg.LLM_MODE, apiKey: cfg.GEMINI_API_KEY, embedModel: cfg.GEMINI_EMBED_MODEL });
  const jobs = new JobRunner();
  const features: Feature[] = [planningFeature, budgetsFeature, proposalsFeature, moneyFeature, weatherFeature, ...(opts.extraFeatures ?? [])];

  const transport = await createTransport(cfg, { world: opts.world });
  let pipeline!: Pipeline;
  const brain = createBrain({ cfg, llm, features });
  pipeline = new Pipeline({
    handler: brain,
    resolveSpace: (chat) => transport.resolveSpace(chat),
    debounceMs: opts.debounceMs,
    maxWaitMs: opts.maxWaitMs,
    pacing: opts.pacing ?? defaultPacing,
    names: opts.names,
    onNewMember: async (chatId, personId) => {
      for (const f of features) if (f.onNewMember) await f.onNewMember(chatId, personId, services).catch((err) => log.warn({ err: (err as Error).message, feature: f.name }, "onNewMember failed"));
    },
  });
  if (opts.world) {
    opts.world.waitIdle = (chatId) => pipeline.waitIdle("sim", chatId);
    opts.world.expect = (chatId) => pipeline.expect("sim", chatId);
  }

  const services: AppServices = {
    cfg,
    llm,
    post: async (chatId, guidPrefix, actions) => {
      await pipeline.enqueue(chatId, guidPrefix, actions);
      await pipeline.flush(chatId);
    },
    poke: (chatId) => pipeline.poke(chatId),
  };
  for (const f of features) {
    if (!f.jobs) continue;
    for (const [kind, handler] of Object.entries(f.jobs(services))) jobs.register(kind, handler);
  }
  jobs.register("outbox.flush", async (payload) => {
    await pipeline.flush(Number(payload.chatId));
  });
  jobs.register("maintenance.prune", async () => pruneOld());
  if (opts.startJobs !== false) jobs.start(1_000);

  await pipeline.recover();
  const done = transport.run((space, message) => pipeline.ingest(space, message)).catch((err) => {
    log.error({ err: (err as Error).message }, "inbound loop crashed");
  });
  log.info({ mode: cfg.IMESSAGE_MODE, llm: cfg.LLM_MODE, agent: cfg.GEMINI_MODEL_AGENT }, "atlas is listening");

  return {
    cfg,
    llm,
    services,
    transport,
    pipeline,
    jobs,
    features,
    done,
    async stop() {
      jobs.stop();
      await transport.stop();
      await done;
    },
  };
}

/** A person types: ~25 ms per character, between 0.6 and 2.5 s, none before the first bubble. */
export function defaultPacing(text: string, index: number): number {
  if (index === 0) return 0;
  return Math.max(600, Math.min(2_500, text.length * 25));
}
