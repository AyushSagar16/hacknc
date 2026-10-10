// Composition root: config → database → LLM → features → brain → pipeline → transport.
// The live process (src/index.ts), the simulator (scripts/sim.ts) and tests all start here.
import type { Config } from "./config.ts";
import { childLog } from "./log.ts";
import { migrate } from "./db/migrate.ts";
import { createBrain } from "./agent/brain.ts";
import type { AppServices, Feature } from "./agent/feature.ts";
import { planningFeature } from "./agent/features/planning.ts";
import { budgetsFeature } from "./agent/features/budgets.ts";
import { proposalsFeature, reconcileOpenNativePolls, setPollSource } from "./agent/features/proposals.ts";
import { linqPollSource } from "./transport/linq/platform.ts";
import { moneyFeature } from "./agent/features/money.ts";
import { weatherFeature } from "./agent/features/weather.ts";
import { memoryFeature } from "./agent/features/memory.ts";
import { presenceFeature, scheduleOnlineNudges } from "./agent/features/presence.ts";
import { searchFeature } from "./agent/features/search.ts";
import { createLlm, type Llm } from "./agent/llm.ts";
import { JobRunner, pruneOld } from "./pipeline/jobs.ts";
import { Pipeline, pacingFromConfig } from "./pipeline/pipeline.ts";
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
  /** Serve the judge console on CONSOLE_PORT (localhost only). */
  console?: boolean;
}

export async function startAtlas(opts: AppOptions): Promise<AtlasApp> {
  const { cfg } = opts;
  const log = childLog({ component: "app" });
  await migrate();
  const llm = opts.llm ?? createLlm({ mode: cfg.LLM_MODE, apiKey: cfg.GEMINI_API_KEY, embedModel: cfg.GEMINI_EMBED_MODEL, fallbacks: cfg.GEMINI_FALLBACK_MODELS });
  const jobs = new JobRunner();
  const features: Feature[] = [planningFeature, budgetsFeature, proposalsFeature, moneyFeature, weatherFeature, memoryFeature, presenceFeature, searchFeature, ...(opts.extraFeatures ?? [])];

  const transport = await createTransport(cfg, { world: opts.world });
  if (transport.linq) setPollSource(linqPollSource(transport.linq.api));
  let pipeline!: Pipeline;
  const brain = createBrain({ cfg, llm, features });
  pipeline = new Pipeline({
    handler: brain,
    resolveSpace: (chat) => transport.resolveSpace(chat),
    debounceMs: opts.debounceMs,
    maxWaitMs: opts.maxWaitMs,
    pacing: opts.pacing ?? pacingFromConfig(cfg),
    agentName: cfg.AGENT_NAME,
    addressedDebounceMs: cfg.ADDRESSED_DEBOUNCE_MS,
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
    nudge: (chatId, reason) => pipeline.nudge(chatId, reason),
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

  let consoleServer: import("node:http").Server | undefined;
  if (opts.console) {
    try {
      const { startConsole } = await import("./console/server.ts");
      consoleServer = await startConsole(cfg.CONSOLE_PORT);
      log.info({ url: `http://127.0.0.1:${cfg.CONSOLE_PORT}` }, "judge console");
    } catch (err) {
      log.warn({ err: (err as Error).message }, "console not started (port busy?)");
    }
  }

  // Probe the primary models in the background so a dead one is skipped from the start. Fallbacks
  // aren't pinged: on the free tier each ping spends a request from a small daily bucket.
  const warm = (llm as { warmup?: (m: string[]) => Promise<Record<string, string>> }).warmup;
  if (warm) void warm.call(llm, [cfg.GEMINI_MODEL_AGENT, cfg.GEMINI_MODEL_GATE, cfg.GEMINI_MODEL_EXTRACT]).then((r) => log.info({ models: r }, "gemini warm-up"));

  await pipeline.recover();
  // Votes cast while Atlas was offline (or dropped) are synced from the provider's voter list.
  const synced = await reconcileOpenNativePolls(services).catch((err) => (log.warn({ err: (err as Error).message }, "poll reconcile failed"), 0));
  if (synced) log.info({ polls: synced }, "synced open polls");
  // Coming online: follow up in groups that were mid-conversation when Atlas was last running.
  const followUps = await scheduleOnlineNudges(cfg).catch((err) => (log.warn({ err: (err as Error).message }, "online follow-ups not scheduled"), 0));
  if (followUps) log.info({ chats: followUps }, "following up in groups with an unanswered message");
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
      consoleServer?.close();
      await transport.stop();
      await done;
    },
  };
}
