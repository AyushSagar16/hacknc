// Per-file disposable database cloned from the migrated template.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { closeDb, useDb } from "../../src/db/pool.ts";
import { ADMIN_URL, TEMPLATE } from "./global-setup.ts";

export const dbAvailable = process.env.ATLAS_TEST_DB === "ready";

export async function freshDb(): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const name = `atlas_t_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: ADMIN_URL.replace(/\/[^/]+$/, `/${name}`), max: 5 });
  useDb(pool);
  return {
    pool,
    drop: async () => {
      await closeDb();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
