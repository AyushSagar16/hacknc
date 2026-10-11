// Wipe Atlas's memory so every chat starts clean: `npm run memory:reset` (dry run), then
// `npm run memory:reset -- --yes`. Deletes extracted facts, recall chunks, asks and Atlas's own
// log. Chats, people, messages, trips, polls, expenses and budgets stay. Messages stay marked as
// extracted, so nothing is re-read; profiles rebuild from new messages. Not a migration on purpose:
// migrations run on every start, and this must only ever run when someone asks for it.
import { config } from "../src/config.ts";
import { closeDb, q } from "../src/db/pool.ts";

const TABLES = ["facts", "memory_chunks", "asks", "atlas_log"] as const;

const url = new URL(config().DATABASE_URL);
console.log(`database: ${url.hostname}:${url.port || 5432}${url.pathname}`);

const counts = await Promise.all(TABLES.map(async (t) => [t, (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n] as const));
for (const [t, n] of counts) console.log(`  ${t}: ${n} rows`);

if (!process.argv.includes("--yes")) {
  console.log("dry run: nothing deleted. Re-run with --yes to delete these rows.");
} else {
  await q(`TRUNCATE ${TABLES.join(", ")}`);
  console.log("memory wiped.");
}
await closeDb();
