// Wipe Atlas's memory so every chat starts clean: `npm run memory:reset` (dry run), then
// `npm run memory:reset -- --yes`. Deletes extracted facts, recall chunks, asks and Atlas's own
// log. Chats, people, messages, trips, polls, expenses and budgets stay. Messages stay marked as
// extracted, so nothing is re-read; profiles rebuild from new messages. Not a migration on purpose:
// migrations run on every start, and this must only ever run when someone asks for it.
import { config } from "../src/config.ts";
import { closeDb } from "../src/db/pool.ts";
import { countMemory, wipeMemory } from "../src/db/wipe.ts";

const url = new URL(config().DATABASE_URL);
console.log(`database: ${url.hostname}:${url.port || 5432}${url.pathname}`);

for (const [t, n] of await countMemory()) console.log(`  ${t}: ${n} rows`);

if (!process.argv.includes("--yes")) {
  console.log("dry run: nothing deleted. Re-run with --yes to delete these rows.");
} else {
  await wipeMemory();
  console.log("memory wiped.");
}
await closeDb();
