// Demo-day tooling around demo/roster.json (copy demo/roster.example.json; it's git-ignored).
//   npm run demo -- status            roster, Nessie links, chats Atlas knows
//   npm run demo -- setup             which roster phones have texted the Linq line (free lines need that)
//   npm run demo -- warm [tripStart]  seed every roster person's Nessie demo profile now and print budgets
//   npm run demo -- reset --yes       wipe trip state for chats with roster people (keeps people + Nessie links)
import { loadConfig, setConfig } from "../src/config.ts";
import { addDays, isoDate, now } from "../src/clock.ts";
import { migrate } from "../src/db/migrate.ts";
import { closeDb, q } from "../src/db/pool.ts";
import { upsertPerson } from "../src/db/repos/core.ts";
import { computeBudget } from "../src/money/budget.ts";
import { formatUsd } from "../src/money/cents.ts";
import { readLedger } from "../src/nessie/ledger.ts";
import { ensureLink, seedPerson, sharedNessie } from "../src/nessie/seed.ts";
import { PERSONAS } from "../src/nessie/personas.ts";
import { loadRoster } from "../src/roster.ts";
import { LinqApi } from "../src/transport/linq/api.ts";

const [cmd, arg] = process.argv.slice(2);
const cfg = loadConfig();
setConfig(cfg);
const roster = loadRoster();
if (roster.length === 0) {
  console.error("demo/roster.json is missing or empty. cp demo/roster.example.json demo/roster.json and put your phones in.");
  process.exit(1);
}
if (roster.length < 3) console.warn("heads up: Apple may only let you add Atlas to a group that already has 3 other members");
await migrate();

switch (cmd) {
  case "status": {
    for (const r of roster) {
      const p = await upsertPerson(r.phone, now(), r.name);
      const link = await ensureLink(p.id, { persona: r.persona });
      console.log(`${r.name.padEnd(10)} …${r.phone.slice(-4)}  persona ${link.persona.padEnd(18)} nessie ${link.seed_status}${link.customer_id ? ` (${link.customer_id})` : ""}`);
    }
    const chats = await q<{ id: number; platform: string; provider_chat_id: string; status: string | null }>(
      `SELECT c.id, c.platform, c.provider_chat_id, t.status FROM chats c LEFT JOIN trips t ON t.chat_id = c.id ORDER BY c.id`,
    );
    for (const c of chats) console.log(`chat ${c.id} ${c.platform} ${c.provider_chat_id.slice(-12)} trip ${c.status ?? "-"}`);
    break;
  }
  case "setup": {
    if (!cfg.LINQ_API_KEY) throw new Error("LINQ_API_KEY missing");
    const api = new LinqApi({ apiKey: cfg.LINQ_API_KEY, baseUrl: cfg.LINQ_API_URL });
    const lines = await api.listPhoneNumbers();
    console.log(`line: ${lines.join(", ") || "(unknown)"}`);
    const known = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await api.call<{ chats?: { is_group?: boolean; handles?: { handle: string; is_me?: boolean }[] }[]; next_cursor?: string | null }>(
        `/chats?${new URLSearchParams({ ...(lines[0] ? { from: lines[0] } : {}), limit: "100", ...(cursor ? { cursor } : {}) })}`,
      );
      for (const chat of res.chats ?? []) if (!chat.is_group) for (const h of chat.handles ?? []) if (!h.is_me) known.add(h.handle);
      if (!res.next_cursor) break;
      cursor = res.next_cursor;
    }
    for (const r of roster) console.log(`${known.has(r.phone) ? "✓" : "✗"} ${r.name} …${r.phone.slice(-4)}${known.has(r.phone) ? "" : "  → text the Atlas number once from this phone (free lines need that)"}`);
    break;
  }
  case "warm": {
    const tripStart = arg ?? addDays(isoDate(now()), 30);
    const client = sharedNessie();
    console.log(client ? "seeding Nessie demo profiles (this takes ~30s per person the first time)" : "no NESSIE_API_KEY: profiles are computed locally (offline)");
    for (const r of roster) {
      const p = await upsertPerson(r.phone, now(), r.name);
      const link = await seedPerson(p.id, { persona: r.persona });
      const ledger = await readLedger(link, client);
      const b = computeBudget({ asOf: isoDate(now()), tripStart, accounts: ledger.accounts, txns: ledger.txns, bills: ledger.bills });
      console.log(`${r.name.padEnd(10)} ${PERSONAS[link.persona].label.padEnd(40)} ${formatUsd(b.budgetCents).padStart(8)}  (${ledger.source}${link.customer_id ? `, customer ${link.customer_id}` : ""})`);
    }
    break;
  }
  case "reset": {
    if (!process.argv.includes("--yes")) {
      console.error("this deletes trip state (messages, facts, budgets, polls, expenses, memory) for chats with roster people in the local database. re-run with --yes");
      process.exit(1);
    }
    const phones = roster.map((r) => r.phone);
    const chats = (await q<{ chat_id: number }>(`SELECT DISTINCT m.chat_id FROM chat_members m JOIN people p ON p.id = m.person_id WHERE p.handle = ANY($1)`, [phones])).map((r) => r.chat_id);
    const people = (await q<{ id: number }>(`SELECT id FROM people WHERE handle = ANY($1)`, [phones])).map((r) => r.id);
    const trips = (await q<{ id: number }>(`SELECT id FROM trips WHERE chat_id = ANY($1)`, [chats])).map((r) => r.id);
    const steps: [string, unknown[]][] = [
      [`DELETE FROM votes WHERE poll_id IN (SELECT id FROM polls WHERE chat_id = ANY($1))`, [chats]],
      [`DELETE FROM polls WHERE chat_id = ANY($1)`, [chats]],
      [`DELETE FROM proposals WHERE trip_id = ANY($1)`, [trips]],
      [`DELETE FROM installments WHERE trip_id = ANY($1)`, [trips]],
      [`DELETE FROM settlements WHERE trip_id = ANY($1)`, [trips]],
      [`DELETE FROM spend_events WHERE trip_id = ANY($1)`, [trips]],
      [`DELETE FROM expenses WHERE trip_id = ANY($1)`, [trips]],
      [`DELETE FROM budgets WHERE trip_id = ANY($1)`, [trips]],
      [`DELETE FROM weather_alerts WHERE trip_id = ANY($1)`, [trips]],
      [`DELETE FROM weather_overrides WHERE trip_id = ANY($1)`, [trips]],
      [`DELETE FROM weather_snapshots WHERE trip_id = ANY($1)`, [trips]],
      [`DELETE FROM confirmations WHERE chat_id = ANY($1)`, [chats]],
      [`DELETE FROM memory_chunks WHERE chat_id = ANY($1) OR person_id = ANY($2)`, [chats, people]],
      [`DELETE FROM facts WHERE person_id = ANY($1)`, [people]],
      [`DELETE FROM asks WHERE chat_id = ANY($1)`, [chats]],
      [`DELETE FROM outbox WHERE chat_id = ANY($1)`, [chats]],
      [`DELETE FROM messages WHERE chat_id = ANY($1)`, [chats]],
      [`DELETE FROM turns WHERE chat_id = ANY($1)`, [chats]],
      [`DELETE FROM trips WHERE id = ANY($1)`, [trips]],
      [`DELETE FROM jobs WHERE done_at IS NULL AND (payload->>'chatId')::bigint = ANY($1)`, [chats]],
      [`UPDATE chats SET intro_sent_at = NULL, quiet_mode = false WHERE id = ANY($1)`, [chats]],
    ];
    for (const [sql, params] of steps) await q(sql, params);
    console.log(`reset ${chats.length} chat(s); Atlas will introduce itself again`);
    break;
  }
  default:
    console.log("usage: npm run demo -- status | setup | warm [tripStart] | reset --yes");
}
await closeDb();
