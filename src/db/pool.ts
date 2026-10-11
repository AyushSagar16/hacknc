// One small pg pool for the whole process. Tiger Cloud's free tier has no connection
// pooler, so the pool stays small (DATABASE_POOL_MAX, default 5).
import pg from "pg";
import { config } from "../config.ts";

// int8 → number (ids and cents stay far below 2^53); date → "YYYY-MM-DD" string (no TZ shift).
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

let pool: pg.Pool | undefined;

/**
 * Tests and the simulator may only ever talk to a disposable clone (atlas_t_<hex> from
 * test/helpers/db.ts, atlas_sim_<hex> from src/sim/session.ts). Anything else, above all the real
 * DATABASE_URL, is refused, so a test that forgets freshDb or background work that outlives
 * closeDb() throws instead of writing into the database a real Atlas sends from.
 */
let disposableOnly = process.env.VITEST !== undefined;
const DISPOSABLE = /^atlas_(t|sim)_[0-9a-f]+$/;

/** Called by the simulator: from here on db() and useDb() accept disposable clones only. */
export function requireDisposableDb(): void {
  disposableOnly = true;
}

export function databaseName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

export function assertDisposable(url: string | undefined): void {
  if (!disposableOnly) return;
  const name = databaseName(url ?? "");
  if (DISPOSABLE.test(name)) return;
  const err = new Error(`refusing database "${name || url}" in a test or simulator: only disposable clones (atlas_t_*, atlas_sim_*) are allowed`);
  process.stderr.write(`[db guard] ${err.stack}\n`);
  throw err;
}

export function db(): pg.Pool {
  if (!pool) {
    const cfg = config();
    assertDisposable(cfg.DATABASE_URL);
    pool = new pg.Pool({
      connectionString: cfg.DATABASE_URL,
      max: cfg.DATABASE_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: /sslmode=(require|verify)/.test(cfg.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
    });
    pool.on("error", () => {
      // An idle client died (e.g. the DB restarted). pg drops it from the pool; the next query reconnects.
    });
  }
  return pool;
}

export function useDb(next: pg.Pool): void {
  assertDisposable(next.options.connectionString);
  pool = next;
}

export async function closeDb(): Promise<void> {
  const p = pool;
  pool = undefined;
  await p?.end();
}

export async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  on: Queryable = db(),
): Promise<T[]> {
  const result = await on.query<T>(sql, params);
  return result.rows;
}

export async function one<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  on: Queryable = db(),
): Promise<T | undefined> {
  const rows = await q<T>(sql, params, on);
  return rows[0];
}

export async function tx<T>(fn: (client: Tx) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
