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

export function db(): pg.Pool {
  if (!pool) {
    const cfg = config();
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
