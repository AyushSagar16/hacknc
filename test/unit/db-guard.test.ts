// Tests and the simulator can never reach the real database: db() and useDb() refuse anything but
// a disposable clone, including after closeDb() when the cached config still names another database.
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, setConfig } from "../../src/config.ts";
import { assertDisposable, closeDb, db, q, useDb } from "../../src/db/pool.ts";

const REAL = "postgres://atlas:atlas@localhost:54329/atlas";

describe("db guard in tests", () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true); // the guard's own report of each refusal
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDb();
  });

  it("refuses the real database and anything not named like a clone", () => {
    for (const url of [REAL, `${REAL}?sslmode=require`, "postgres://u:p@db.example.com:5432/tsdb", "postgres://atlas:atlas@localhost:54329/atlas_sim_template", "postgres://atlas:atlas@localhost:54329/atlas_test_no_database"]) {
      expect(() => assertDisposable(url), url).toThrow(/refusing database/);
    }
  });

  it("accepts the clones tests and the simulator make", () => {
    expect(() => assertDisposable("postgres://atlas:atlas@localhost:54329/atlas_t_0a1b2c3d4e")).not.toThrow();
    expect(() => assertDisposable("postgres://atlas:atlas@localhost:54329/atlas_sim_deadbeef?sslmode=disable")).not.toThrow();
  });

  it("never lazily connects to the configured database once the clone is closed", async () => {
    setConfig(loadConfig({ ...process.env, DATABASE_URL: REAL }));
    expect(() => db()).toThrow(/refusing database "atlas"/);
    await expect(async () => q(`SELECT 1`)).rejects.toThrow(/refusing database/);
  });

  it("refuses a real pool handed to useDb", async () => {
    const pool = new pg.Pool({ connectionString: REAL });
    expect(() => useDb(pool)).toThrow(/refusing database/);
    await pool.end();
  });

  it("points tests at a database that can't be the real one", () => {
    expect(process.env.DATABASE_URL).toMatch(/\/atlas_test_no_database$/);
    expect(() => loadConfig().DATABASE_URL && assertDisposable(loadConfig().DATABASE_URL)).toThrow(/refusing database/);
  });
});
