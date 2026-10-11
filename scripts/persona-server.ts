// A simulated group chat behind a tiny localhost HTTP API, so test drivers (people, scripts or
// persona agents) can talk to the real Atlas with fake phone numbers and no real line:
//   npx tsx --env-file-if-exists=.env scripts/persona-server.ts --port 8801 --members maya,leo,priya
// Each process gets its own throwaway database (dropped on exit) and uses live Gemini when a key
// is set. Endpoints (JSON):
//   POST /step   {"line": "maya: hi atlas"}  any simulator step: "name: text", "name vote 2",
//                "name react like atlas.last", "clock +3d", "jobs", "sam joins". Returns new chat lines.
//   GET  /wait?ms=8000   wait, then return lines that arrived since the last read (follow-ups, jobs)
//   GET  /transcript     the whole chat
//   GET  /state          trip, budgets, polls, installments, expenses
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { q } from "../src/db/pool.ts";
import { findChat } from "../src/db/repos/core.ts";
import { formatEntry, ScenarioRunner } from "../src/sim/script.ts";
import { startSession } from "../src/sim/session.ts";
import { simExtensions } from "../src/sim/extensions.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const port = Number(option("port", "8801"));
const members = option("members", "maya,leo,priya").split(",").map((m) => m.trim().toLowerCase());
const chatId = `persona-${port}`;

const session = await startSession({
  llmMode: process.env.GEMINI_API_KEY ? "live" : "scripted",
  debounceMs: 900,
  logFile: join(process.cwd(), ".sim", `persona-${port}.log`),
  env: { NUDGE_IDLE_SECONDS: option("nudge", "60") },
});
session.app.jobs.start(1_000);
const runner = new ScenarioRunner(session, () => {}, { live: true, chatId, extensions: simExtensions(session) });
await runner.step(`members ${members.join(" ")}`);
await runner.step(`atlas joins by ${members[0]}`);

const line = (e: Parameters<typeof formatEntry>[0]) => (e.kind === "system" ? `· ${e.text}` : `${e.from}${e.replyTo ? ` (replying to ${e.replyTo})` : ""}: ${e.text}`);
let cursor = 0;
const fresh = () => {
  const all = runner.chat?.transcript ?? [];
  const out = all.slice(cursor).map(line);
  cursor = all.length;
  return out;
};
fresh();

let busy = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = busy.then(fn, fn);
  busy = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

async function state(): Promise<unknown> {
  const chat = await findChat("sim", chatId);
  if (!chat) return {};
  const [trip] = await q(`SELECT status, destination_name, start_date, end_date, split_mode FROM trips WHERE chat_id = $1`, [chat.id]);
  const budgets = await q(
    `SELECT p.display_name AS who, b.suggested_cents, b.adjusted_cents, b.visibility FROM budgets b JOIN people p ON p.id = b.person_id JOIN trips t ON t.id = b.trip_id WHERE t.chat_id = $1`,
    [chat.id],
  );
  const polls = await q(`SELECT id, kind, status, options, winner_idx FROM polls WHERE chat_id = $1 ORDER BY id`, [chat.id]);
  const installments = await q(
    `SELECT p.display_name AS who, i.due_date, i.amount_cents, i.status FROM installments i JOIN people p ON p.id = i.person_id JOIN trips t ON t.id = i.trip_id WHERE t.chat_id = $1 ORDER BY who, due_date`,
    [chat.id],
  );
  const expenses = await q(`SELECT e.description, e.amount_cents, e.shares, e.status FROM expenses e JOIN trips t ON t.id = e.trip_id WHERE t.chat_id = $1`, [chat.id]);
  return { trip, budgets, polls, installments, expenses };
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 1));
};
const body = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method === "POST" && url.pathname === "/step") {
      const { line: step } = await body(req);
      if (typeof step !== "string" || !step.trim()) return send(res, 400, { error: 'send {"line": "maya: hi"}' });
      const lines = await serial(async () => {
        await runner.step(step.trim());
        // Let a reply that a job posts right after (budgets, follow-ups) land too.
        await new Promise((r) => setTimeout(r, 1_500));
        return fresh();
      });
      return send(res, 200, { lines });
    }
    if (req.method === "GET" && url.pathname === "/wait") {
      const ms = Math.min(60_000, Number(url.searchParams.get("ms") ?? 8_000));
      await new Promise((r) => setTimeout(r, ms));
      return send(res, 200, { lines: await serial(async () => fresh()) });
    }
    if (req.method === "GET" && url.pathname === "/transcript") return send(res, 200, { lines: (runner.chat?.transcript ?? []).map(line) });
    if (req.method === "GET" && url.pathname === "/state") return send(res, 200, await state());
    send(res, 404, { error: "POST /step, GET /wait, /transcript, /state" });
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
  }
});
server.listen(port, "127.0.0.1", () => console.log(`persona chat ${chatId} with ${members.join(", ")} (fake numbers) on http://127.0.0.1:${port}`));

const stop = async () => {
  server.close();
  await session.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
