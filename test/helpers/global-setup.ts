// Builds a migrated template database once per test run; each integration test file
// clones it (CREATE DATABASE ... TEMPLATE) so files never share state. The template name
// is per run, so concurrent `vitest` processes never touch each other's databases.
import pg from "pg";
import { migrate } from "../../src/db/migrate.ts";

// The maintenance database is `postgres`, never `atlas` (the real one): tests only CREATE and DROP
// their own clones from it.
export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://atlas:atlas@localhost:54329/postgres";
export const TEMPLATE = process.env.ATLAS_TEST_TEMPLATE ?? `atlas_tpl_${process.pid}`;

export default async function setup(): Promise<() => Promise<void>> {
  // Workers inherit this env. A config loaded from process.env (anything that skips freshDb) then
  // names a database that doesn't exist and that db()'s guard refuses, never the real DATABASE_URL.
  process.env.DATABASE_URL = ADMIN_URL.replace(/\/[^/]+$/, "/atlas_test_no_database");
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch {
    console.warn("[tests] Postgres not reachable; integration tests will be skipped. Run `npm run db:up`.");
    process.env.ATLAS_TEST_DB = "unavailable";
    return async () => {};
  }
  await dropTemplate(admin, TEMPLATE);
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
  process.env.ATLAS_TEST_TEMPLATE = TEMPLATE;
  return async () => {
    const a = new pg.Client({ connectionString: ADMIN_URL });
    await a.connect();
    await dropTemplate(a, TEMPLATE);
    await a.end();
  };
}

async function dropTemplate(admin: pg.Client, name: string): Promise<void> {
  const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
  if (!exists.rowCount) return;
  await admin.query(`ALTER DATABASE ${name} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`);
  await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
}
