// Preflight for a demo: config presence (never values), database + extensions, the selected
// line, Gemini, Nessie, SerpApi and Open-Meteo reachability, and stale Linq relay webhooks.
//   npm run doctor
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import pg from "pg";
import { loadConfig } from "../src/config.ts";
import { GeminiLlm } from "../src/agent/llm.ts";
import { LinqApi } from "../src/transport/linq/api.ts";

type Check = { name: string; ok: boolean | "warn"; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean | "warn", detail = "") => checks.push({ name, ok, detail });
const cfg = loadConfig();

// Node + env file
const [major, minor] = process.versions.node.split(".").map(Number);
add("node >= 22.9", major! > 22 || (major === 22 && minor! >= 9), process.versions.node);
add(".env present", existsSync(".env") ? true : "warn", existsSync(".env") ? "" : "no .env in this folder; copy .env.example");
const keys = ["LINQ_API_KEY", "GEMINI_API_KEY", "NESSIE_API_KEY", "SERPAPI_API_KEY", "DATABASE_URL"] as const;
add("keys set", "warn", keys.map((k) => `${k}=${process.env[k] ? "set" : "missing"}`).join("  "));

// Database
try {
  const client = new pg.Client({ connectionString: cfg.DATABASE_URL, ssl: /sslmode=require/.test(cfg.DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  const ext = await client.query<{ extname: string; extversion: string }>(`SELECT extname, extversion FROM pg_extension WHERE extname IN ('timescaledb','vector','vectorscale')`);
  const names = ext.rows.map((r) => `${r.extname} ${r.extversion}`);
  add("database reachable", true, cfg.DATABASE_URL.replace(/\/\/[^@]*@/, "//***@"));
  add("timescaledb + pgvector", names.some((n) => n.startsWith("timescaledb")) && names.some((n) => n.startsWith("vector")), names.join(", ") || "run npm run migrate");
  add("pgvectorscale (diskann)", names.some((n) => n.startsWith("vectorscale")) ? true : "warn", names.some((n) => n.startsWith("vectorscale")) ? "" : "falls back to an HNSW index");
  const mig = await client.query(`SELECT count(*)::int AS n FROM schema_migrations`).catch(() => ({ rows: [{ n: 0 }] }));
  add("migrations applied", (mig.rows[0] as { n: number }).n > 0, `${(mig.rows[0] as { n: number }).n} applied (npm start applies new ones)`);
  await client.end();
} catch (err) {
  add("database reachable", false, `${(err as Error).message} — npm run db:up for local, or set DATABASE_URL`);
}

// Line
add("IMESSAGE_MODE", true, cfg.IMESSAGE_MODE);
if (cfg.IMESSAGE_MODE === "linq") {
  const cli = spawnSync("linq", ["whoami"], { encoding: "utf8" });
  add("linq CLI logged in", cli.status === 0, cli.status === 0 ? "" : cli.error ? "install: npm i -g @linqapp/cli" : "run: linq login");
  if (cfg.LINQ_API_KEY) {
    const api = new LinqApi({ apiKey: cfg.LINQ_API_KEY, baseUrl: cfg.LINQ_API_URL, maxRetries: 0, timeoutMs: 8_000 });
    try {
      const phones = await api.listPhoneNumbers();
      add("linq API key", true, `line ${phones.map((p) => `…${p.slice(-4)}`).join(", ") || "(none listed)"}`);
      const subs = await api.listWebhookSubscriptions().catch(() => []);
      const stale = subs.filter((s) => /\/relay\//.test(s.target_url));
      add("no stale relay webhooks", stale.length === 0 ? true : "warn", stale.length ? `${stale.length} leftover (npm run live removes them)` : "");
    } catch (err) {
      add("linq API key", false, (err as Error).message.slice(0, 120));
    }
  } else add("linq API key", false, "LINQ_API_KEY missing");
  if (cfg.LINQ_WEBHOOK_MODE === "subscription" && !cfg.LINQ_WEBHOOK_SECRET) add("webhook secret", false, "subscription mode needs LINQ_WEBHOOK_SECRET");
  add(`port ${cfg.LINQ_WEBHOOK_PORT} free`, await portFree(cfg.LINQ_WEBHOOK_PORT), "");
} else if (cfg.IMESSAGE_MODE === "local") {
  add("macOS", process.platform === "darwin", "local mode reads the Messages database (Full Disk Access for your terminal)");
} else if (cfg.IMESSAGE_MODE === "cloud") {
  add("photon project", Boolean(cfg.PROJECT_ID && cfg.PROJECT_SECRET), "groups need a dedicated Business line");
}

// Gemini
if (cfg.GEMINI_API_KEY) {
  const g = new GeminiLlm(cfg.GEMINI_API_KEY, cfg.GEMINI_EMBED_MODEL);
  for (const [role, model] of [["gate", cfg.GEMINI_MODEL_GATE], ["agent", cfg.GEMINI_MODEL_AGENT]] as const) {
    const t0 = Date.now();
    try {
      await g.generate({ role, model, system: "reply with the word ok", contents: [{ role: "user", parts: [{ text: "ping" }] }], timeoutMs: 15_000, maxOutputTokens: 5 });
      add(`gemini ${model}`, true, `${Date.now() - t0} ms`);
    } catch (err) {
      add(`gemini ${model}`, false, (err as Error).message.slice(0, 140));
    }
  }
  try {
    const [v] = await g.embed(["hello"], "query");
    add(`embeddings ${cfg.GEMINI_EMBED_MODEL}`, v?.length === 768, `${v?.length} dims`);
  } catch (err) {
    add(`embeddings ${cfg.GEMINI_EMBED_MODEL}`, false, (err as Error).message.slice(0, 140));
  }
} else add("gemini", "warn", "no GEMINI_API_KEY: commands, polls and money still work; language features are off");

// Nessie
if (cfg.NESSIE_API_KEY) {
  try {
    const res = await fetch(`${cfg.NESSIE_BASE_URL.replace(/^http:/, "https:")}/merchants?key=${encodeURIComponent(cfg.NESSIE_API_KEY)}`, { signal: AbortSignal.timeout(10_000) });
    add("nessie reachable", res.ok, `${res.status} (a wrong key still returns 200 here; npm run nessie:probe proves the key)`);
  } catch (err) {
    add("nessie reachable", false, (err as Error).message);
  }
  add("nessie probed", existsSync("data/nessie-capabilities.json") ? true : "warn", existsSync("data/nessie-capabilities.json") ? "" : "run npm run nessie:probe once");
} else add("nessie", "warn", "no NESSIE_API_KEY: budgets use the same demo profiles computed locally (labeled offline)");

// SerpApi (account.json is free and doesn't use a search)
if (cfg.SERPAPI_API_KEY) {
  try {
    const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(cfg.SERPAPI_API_KEY)}`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { plan_searches_left?: number; total_searches_left?: number };
    add("serpapi", res.ok, `${body.total_searches_left ?? body.plan_searches_left ?? "?"} searches left this month`);
  } catch (err) {
    add("serpapi", false, (err as Error).message);
  }
} else add("serpapi", "warn", "no SERPAPI_API_KEY: prices are labeled catalog estimates");

// Open-Meteo
try {
  const res = await fetch("https://api.open-meteo.com/v1/forecast?latitude=35.9&longitude=-79.05&daily=weather_code&forecast_days=1", { signal: AbortSignal.timeout(8_000) });
  add("open-meteo", res.ok, `${res.status}`);
} catch (err) {
  add("open-meteo", false, (err as Error).message);
}
add(`console port ${cfg.CONSOLE_PORT} free`, await portFree(cfg.CONSOLE_PORT), "");

for (const c of checks) console.log(`${c.ok === true ? "\x1b[32m✓" : c.ok === "warn" ? "\x1b[33m!" : "\x1b[31m✗"}\x1b[0m ${c.name}${c.detail ? `  \x1b[90m${c.detail}\x1b[0m` : ""}`);
const failed = checks.filter((c) => c.ok === false).length;
console.log(failed ? `\n${failed} problem(s) to fix` : "\nready");
process.exit(failed ? 1 : 0);

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
