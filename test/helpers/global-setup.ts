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
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEMPLATE}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: ADMIN_URL.replace(/\/[^/]+$/, `/${TEMPLATE}`), max: 1 });
  await migrate(pool);
  await pool.end();
  process.env.ATLAS_TEST_DB = "ready";
}
