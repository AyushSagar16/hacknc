// Clean start for the real line. Clears everything earlier runs left behind, then runs live.ts.
//   npm run up                  clean up, then start (tunnel, or the relay if no tunnel opens)
//   npm run up -- --relay       same, forcing the linq CLI relay (anything after up goes to live.ts)
//   npm run up -- --clean-only  clean up and stop
// Checklist, in order:
//   1. Atlas processes from this repo (any checkout of it): live, sim, npm start/dev
//   2. Orphaned cloudflared tunnels and `linq webhooks listen` relays pointed at the webhook port
//   3. Anything still listening on the webhook and console ports
//   4. Linq webhook subscriptions left by earlier sessions (relay and trycloudflare targets)
//   5. Database reachable (starts docker compose for the local one if it isn't)
// Processes get SIGINT first so a running live.ts deletes its own subscription, then SIGKILL.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import pg from "pg";
import { loadConfig } from "../src/config.ts";
import { LinqApi } from "../src/transport/linq/api.ts";

const cfg = loadConfig({ ...process.env, IMESSAGE_MODE: "linq" });
const args = process.argv.slice(2);
const cleanOnly = args.includes("--clean-only");
const passthrough = args.filter((a) => a !== "--clean-only");
const WEBHOOK = cfg.LINQ_WEBHOOK_PORT;
const CONSOLE = cfg.CONSOLE_PORT;

let failed = 0;
const check = (ok: boolean | "warn", name: string, detail = "") => {
  if (ok === false) failed++;
  console.log(`${ok === true ? "\x1b[32m✓" : ok === "warn" ? "\x1b[33m!" : "\x1b[31m✗"}\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ""}`);
};

type Proc = { pid: number; ppid: number; command: string };

function processes(): Proc[] {
  const out = spawnSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }] : [];
  });
}

// This process and the npm/shell chain that started it are never touched.
function ancestors(all: Proc[]): Set<number> {
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const keep = new Set<number>();
  for (let pid: number | undefined = process.pid; pid && !keep.has(pid); pid = byPid.get(pid)?.ppid) keep.add(pid);
  return keep;
}

function cwdOf(pid: number): string | undefined {
  const out = spawnSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], { encoding: "utf8" }).stdout ?? "";
  return /^n(.+)$/m.exec(out)?.[1];
}

// A checkout of this repo, worktrees included: its package.json is named hacknc.
function isAtlasCheckout(dir: string | undefined): boolean {
  if (!dir) return false;
  try {
    return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name === "hacknc";
  } catch {
    return false;
  }
}

function listeners(port: number): number[] {
  const out = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").filter(Boolean).map(Number);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stop(pids: number[]): Promise<number> {
  const targets = pids.filter(alive);
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGINT");
    } catch {}
  }
  // live.ts gives its relay up to 10s to remove its webhook on SIGINT.
  for (let waited = 0; waited < 12_000 && targets.some(alive); waited += 250) await new Promise((r) => setTimeout(r, 250));
  for (const pid of targets.filter(alive)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return targets.length;
}

// "live.ts (pid 123)", "cloudflared (pid 456)": the script or program, not the full node command.
const short = (command: string) => /\b(?:scripts|src)\/[\w-]+\.ts\b/.exec(command)?.[0] ?? command.split(/\s+/)[0]!.split("/").pop()!;
const describe = (procs: Proc[]) => procs.map((p) => `${short(p.command)} (pid ${p.pid})`).join(", ");

console.log("cleaning up earlier runs\n");

// 1. Atlas processes. Kill the tsx wrapper and its node child together.
{
  const all = processes();
  const keep = ancestors(all);
  const atlas = all.filter((p) => !keep.has(p.pid) && /\btsx\b.*\b(scripts\/(live|sim)\.ts|src\/index\.ts)\b/.test(p.command) && isAtlasCheckout(cwdOf(p.pid)));
  const n = await stop(atlas.map((p) => p.pid));
  check(true, "atlas processes from earlier runs", n ? `stopped ${n}: ${describe(atlas)}` : "none running");
}

// 2. Tunnels and relays, including ones orphaned when their live.ts died without cleaning up.
{
  const all = processes();
  const local = new RegExp(`(127\\.0\\.0\\.1|localhost):${WEBHOOK}\\b`);
  const tunnels = all.filter((p) => /\bcloudflared\b.*\btunnel\b/.test(p.command) && local.test(p.command));
  const relays = all.filter((p) => /\blinq\b.*\bwebhooks\s+listen\b/.test(p.command));
  const n = await stop([...tunnels, ...relays].map((p) => p.pid));
  check(true, "cloudflared tunnels and linq relays", n ? `stopped ${n}: ${describe([...tunnels, ...relays])}` : "none running");
}

// 3. Whatever still holds the ports.
for (const [port, name] of [
  [WEBHOOK, "webhook"],
  [CONSOLE, "console"],
] as const) {
  const keep = ancestors(processes());
  const holders = listeners(port).filter((pid) => !keep.has(pid));
  const cmds = processes().filter((p) => holders.includes(p.pid));
  if (holders.length) await stop(holders);
  const free = await portFree(port);
  check(free, `${name} port ${port} free`, holders.length ? `stopped ${describe(cmds)}` : "");
}

// 4. Webhook subscriptions. Session targets only: a relay URL or a quick tunnel. Anything else
// (a deployed server) is listed but left alone.
if (cfg.LINQ_API_KEY) {
  const api = new LinqApi({ apiKey: cfg.LINQ_API_KEY, baseUrl: cfg.LINQ_API_URL, timeoutMs: 10_000 });
  try {
    const subs = await api.listWebhookSubscriptions();
    const stale = subs.filter((s) => /webhook\.linqapp\.com\/relay\/|trycloudflare\.com/.test(s.target_url));
    const others = subs.filter((s) => !stale.includes(s));
    let removed = 0;
    for (const s of stale) await api.deleteWebhookSubscription(s.id).then(() => removed++, () => {});
    check(removed === stale.length, "linq webhook subscriptions from earlier sessions", stale.length ? `removed ${removed} of ${stale.length}` : "none left over");
    if (others.length) check("warn", "other webhook subscriptions kept", others.map((s) => s.target_url).join(", "));
  } catch (err) {
    check(false, "linq webhook subscriptions", (err as Error).message.slice(0, 120));
  }
} else check(false, "linq webhook subscriptions", "LINQ_API_KEY missing");

// 5. Database.
{
  const local = /@(localhost|127\.0\.0\.1):54329\//.test(cfg.DATABASE_URL);
  let ok = await dbReachable();
  let detail = "";
  if (!ok && local) {
    const up = spawnSync("docker", ["compose", "up", "-d", "--wait"], { encoding: "utf8" });
    ok = up.status === 0 && (await dbReachable());
    detail = ok ? "started docker compose" : (up.stderr || up.error?.message || "docker compose failed").trim().split("\n").pop()!;
  } else if (!ok) detail = "DATABASE_URL isn't reachable";
  check(ok, "database reachable", detail || cfg.DATABASE_URL.replace(/\/\/[^@]*@/, "//***@"));
}

if (failed) {
  console.log(`\n${failed} problem(s); not starting`);
  process.exit(1);
}
if (cleanOnly) {
  console.log("\nclean");
  process.exit(0);
}

console.log("\nclean; starting atlas\n");
// live.ts is in the same process group, so ctrl-c in the terminal reaches it directly and it
// shuts down on its own; this process just waits and exits with it.
const child = spawn(process.execPath, [...process.execArgv, "scripts/live.ts", ...passthrough], { stdio: "inherit" });
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

async function dbReachable(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: cfg.DATABASE_URL,
    ssl: /sslmode=require/.test(cfg.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5_000,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
