// Apply pending migrations: `npm run migrate`.
import { migrate } from "../src/db/migrate.ts";
import { closeDb, db } from "../src/db/pool.ts";

const applied = await migrate();
console.log(applied.length ? `applied: ${applied.join(", ")}` : "schema up to date");
const ext = await db().query<{ extname: string; extversion: string }>(
  "SELECT extname, extversion FROM pg_extension WHERE extname IN ('timescaledb','vector','vectorscale') ORDER BY 1",
);
console.log("extensions:", ext.rows.map((r) => `${r.extname} ${r.extversion}`).join(", "));
await closeDb();
