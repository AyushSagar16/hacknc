// The terminal simulator: a fake friend group talking to the real Atlas (pipeline, brain,
// database, Nessie/SerpApi/Open-Meteo when keys are set) with no phones.
//   npm run sim                         interactive group chat (maya, leo, priya)
//   npm run sim -- run scenario.chat    play a script; exits 1 on the first failed expectation
//   flags: --live (real Gemini even for scripted lines' roles), --members a,b,c, --keep (keep the db)
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { q } from "../src/db/pool.ts";
import { findChat } from "../src/db/repos/core.ts";
import { formatEntry, loadScript, ScenarioRunner } from "../src/sim/script.ts";
import { startSession } from "../src/sim/session.ts";
import { simExtensions } from "../src/sim/extensions.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const hasKey = Boolean(process.env.GEMINI_API_KEY);
const live = flag("live") || (args[0] !== "run" && hasKey);

const session = await startSession({
  llmMode: live ? "live" : "scripted",
  debounceMs: args[0] === "run" ? 20 : 900,
  logFile: join(process.cwd(), ".sim", "atlas.log"),
  console: args[0] !== "run",
});
const print = (e: Parameters<typeof formatEntry>[0]) => console.log(formatEntry(e));

if (args[0] === "run") {
  const file = args[1];
  if (!file) throw new Error("usage: npm run sim -- run <file.chat>");
  const runner = new ScenarioRunner(session, print, { live, extensions: simExtensions(session) });
  const report = await runner.run(await loadScript(file));
  if (report.ok) console.log(`\n\x1b[32m✓ ${file} (${report.steps} steps)\x1b[0m`);
  else console.log(`\n\x1b[31m✗ ${file} line ${report.failure!.line}: ${report.failure!.text}\n${report.failure!.reason}\x1b[0m`);
  await session.close({ keepDb: flag("keep") });
  process.exit(report.ok ? 0 : 1);
}

// Interactive.
const members = (option("members") ?? "maya,leo,priya").split(",");
const runner = new ScenarioRunner(session, print, { live, chatId: "sim-group", extensions: simExtensions(session) });
await runner.step(`members ${members.join(" ")}`);
console.log(`\x1b[90msimulator: ${members.join(", ")} in a group chat. model: ${live ? "gemini (live)" : "scripted (no GEMINI_API_KEY; script replies with ~agent ...)"}`);
console.log(`judge console: http://127.0.0.1:${session.cfg.CONSOLE_PORT}`);
console.log(`type "maya: hi", "atlas joins", "leo react like atlas.last", "maya vote 2", "clock +2d", "/state", "/facts", "/help", "/quit"\x1b[0m\n`);
if (!flag("empty")) await runner.step("atlas joins by maya");

const rl = createInterface({ input: stdin, output: stdout, prompt: "> " });
rl.prompt();
for await (const line of rl) {
  const text = line.trim();
  try {
    if (!text) {
      // nothing
    } else if (text === "/quit" || text === "/exit") {
      break;
    } else if (text === "/help") {
      console.log("steps: name: text | name reply atlas.last: text | name react like atlas.last | name vote 2 | atlas joins | sam joins | maya leaves | clock +3d | jobs | ~agent text: ... | expect ...");
      console.log("inspect: /state /facts /budgets /expenses /turns /transcript");
    } else if (text.startsWith("/")) {
      await inspect(text.slice(1));
    } else {
      await runner.step(text);
    }
  } catch (err) {
    console.log(`\x1b[31m${(err as Error).message}\x1b[0m`);
  }
  rl.prompt();
}
await session.close({ keepDb: flag("keep") });
process.exit(0);

async function inspect(what: string): Promise<void> {
  const chat = await findChat("sim", "sim-group");
  const id = chat?.id ?? -1;
  const views: Record<string, string> = {
    state: `SELECT status, destination_name, start_date, end_date FROM trips WHERE chat_id = ${id}`,
    facts: `SELECT p.display_name AS who, f.key, f.value, f.polarity, f.confidence, f.quote, f.superseded_by IS NOT NULL AS superseded FROM facts f JOIN people p ON p.id = f.person_id ORDER BY f.id`,
    budgets: `SELECT p.display_name AS who, b.suggested_cents, b.adjusted_cents, b.visibility FROM budgets b JOIN people p ON p.id = b.person_id`,
    expenses: `SELECT e.id, p.display_name AS payer, e.amount_cents, e.description, e.status, e.nessie_purchase_id FROM expenses e JOIN people p ON p.id = e.payer_id ORDER BY e.id`,
    turns: `SELECT id, route, addressed, gate_decision, gate_reason, latency_ms FROM turns WHERE chat_id = ${id} ORDER BY id DESC LIMIT 10`,
  };
  if (what === "transcript") {
    for (const e of runner.need().transcript) print(e);
    return;
  }
  const sql = views[what];
  if (!sql) throw new Error(`no view /${what}`);
  console.table(await q(sql));
}
