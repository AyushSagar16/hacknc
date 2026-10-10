// Plain-SQL migrations, applied in filename order. A file whose first line is
// `-- atlas:no-transaction` runs outside a transaction (continuous aggregates need that).
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type pg from "pg";
import { db } from "./pool.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(pool: pg.Pool = db()): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  // Serialize concurrent boots (tests, sim + live) on one advisory lock.
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(424242)");
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(DIR, file), "utf8");
      const noTx = sql.startsWith("-- atlas:no-transaction");
      try {
        if (noTx) {
          for (const statement of splitStatements(sql)) await client.query(statement);
          await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
        } else {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
          await client.query("COMMIT");
        }
      } catch (err) {
        if (!noTx) await client.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(424242)").catch(() => {});
    client.release();
  }
  return applied;
}

/** Split a no-transaction file on statement terminators (no semicolons inside our CA bodies' strings). */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}
