// A simulator session: Atlas running against a throwaway Postgres database on the sim line, with
// a movable clock and either scripted, live or cassette model answers.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { loadConfig, setConfig, type Config } from "../config.ts";
import { OffsetClock, setClock } from "../clock.ts";
import { migrate } from "../db/migrate.ts";
import { closeDb, useDb } from "../db/pool.ts";
import { resetLogger } from "../log.ts";
import { startAtlas, type AtlasApp } from "../app.ts";
import { createLlm, type Llm } from "../agent/llm.ts";
import { SimWorld } from "../transport/sim/platform.ts";
import { ScriptedLlm } from "./scriptedLlm.ts";

export interface SimSession {
  app: AtlasApp;
  world: SimWorld;
  clock: OffsetClock;
  llm: ScriptedLlm;
  cfg: Config;
  databaseName: string;
  close(opts?: { keepDb?: boolean }): Promise<void>;
}

export interface SessionOptions {
  /** scripted: script lines answer the model (offline). live: real Gemini, script lines ignored. */
  llmMode: "scripted" | "live";
  debounceMs?: number;
  pacing?: boolean;
  database?: string; // reuse a named database (REPL); default: a fresh clone
  env?: Record<string, string>;
  logFile?: string;
  console?: boolean;
}

const adminUrl = (cfg: Config) => cfg.DATABASE_URL;
const withDb = (url: string, name: string) => url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
const TEMPLATE = "atlas_sim_template";

/** Build (once per process) a migrated template database, then clone it per session. */
async function cloneDatabase(cfg: Config): Promise<string> {
  const admin = new pg.Client({ connectionString: adminUrl(cfg) });
  await admin.connect();
  try {
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEMPLATE]);
    if (!exists.rowCount || !templateReady) {
      if (exists.rowCount) {
        await admin.query(`ALTER DATABASE ${TEMPLATE} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`);
        await admin.query(`DROP DATABASE ${TEMPLATE} WITH (FORCE)`);
      }
      await admin.query(`CREATE DATABASE ${TEMPLATE}`);
      const pool = new pg.Pool({ connectionString: withDb(adminUrl(cfg), TEMPLATE), max: 1 });
      await migrate(pool);
      await pool.end();
      await admin.query(`ALTER DATABASE ${TEMPLATE} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [TEMPLATE]);
      templateReady = true;
    }
    const name = `atlas_sim_${randomBytes(4).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
    return name;
  } finally {
    await admin.end();
  }
}
let templateReady = false;

async function dropDatabase(cfg: Config, name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl(cfg) });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

export async function startSession(opts: SessionOptions): Promise<SimSession> {
  if (opts.logFile) {
    process.env.LOG_FILE = opts.logFile;
    resetLogger();
  }
  const base = loadConfig({ ...process.env, IMESSAGE_MODE: "sim", ...opts.env });
  const databaseName = opts.database ?? (await cloneDatabase(base));
  const cfg = { ...base, DATABASE_URL: withDb(base.DATABASE_URL, databaseName) };
  setConfig(cfg);
  if (opts.database) {
    const admin = new pg.Client({ connectionString: base.DATABASE_URL });
    await admin.connect();
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [databaseName]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE ${databaseName}`);
    await admin.end();
  }
  useDb(new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 5 }));
  await migrate();

  const clock = new OffsetClock();
  setClock(clock);
  const world = new SimWorld();
  const live: Llm | undefined = opts.llmMode === "live" ? createLlm({ mode: "live", apiKey: cfg.GEMINI_API_KEY, embedModel: cfg.GEMINI_EMBED_MODEL }) : undefined;
  const llm = new ScriptedLlm(live);
  const app = await startAtlas({
    cfg,
    llm,
    world,
    debounceMs: opts.debounceMs ?? 20,
    maxWaitMs: Math.max(400, (opts.debounceMs ?? 20) * 4),
    pacing: opts.pacing ? undefined : () => 0,
    startJobs: false,
    names: (h) => world.nameOf(h),
    console: opts.console,
  });
  return {
    app,
    world,
    clock,
    llm,
    cfg,
    databaseName,
    async close(closeOpts = {}) {
      await app.stop();
      await closeDb();
      if (!opts.database && !closeOpts.keepDb) await dropDatabase(base, databaseName).catch(() => {});
    },
  };
}
