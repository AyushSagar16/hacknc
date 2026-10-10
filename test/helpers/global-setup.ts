// Builds a migrated template database once per test run; each integration test file
// clones it (CREATE DATABASE ... TEMPLATE) so files never share state.
import pg from "pg";
import { migrate } from "../../src/db/migrate.ts";

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://atlas:atlas@localhost:54329/atlas";
export const TEMPLATE = "atlas_test_template";

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch {
    console.warn("[tests] Postgres not reachable; integration tests will be skipped. Run `npm run db:up`.");
    process.env.ATLAS_TEST_DB = "unavailable";
    return;
  }
  const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEMPLATE]);
  if (exists.rowCount) {
    await admin.query(`ALTER DATABASE ${TEMPLATE} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`);
    await admin.query(`DROP DATABASE ${TEMPLATE} WITH (FORCE)`);
  }
  // Leftover per-file databases from interrupted runs.
  const stale = await admin.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE 'atlas_test_%' AND datname <> $1`, [TEMPLATE]);
  for (const row of stale.rows) await admin.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEMPLATE}`);
  const pool = new pg.Pool({ connectionString: ADMIN_URL.replace(/\/[^/]+$/, `/${TEMPLATE}`), max: 1 });
  await migrate(pool);
  await pool.end();
  // TimescaleDB's background scheduler connects to every database with the extension, which
  // blocks CREATE DATABASE ... TEMPLATE. A template that refuses connections can still be cloned.
  await admin.query(`ALTER DATABASE ${TEMPLATE} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [TEMPLATE]);
  await admin.end();
  process.env.ATLAS_TEST_DB = "ready";
}
