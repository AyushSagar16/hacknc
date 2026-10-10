// The real line, one command: Atlas on IMESSAGE_MODE=linq plus a supervised
// `linq webhooks listen` relay forwarding Linq's webhooks to our local server. The relay
// prints a per-session signing secret; we capture it (never print it) so every delivery is
// signature-checked. Stale relay subscriptions from crashed sessions are removed first,
// because they made Linq deliver events minutes late and out of order.
import { spawn, spawnSync } from "node:child_process";
import { loadConfig, setConfig } from "../src/config.ts";
import { startAtlas } from "../src/app.ts";
import { rosterName } from "../src/roster.ts";
import { WEBHOOK_PATH } from "../src/transport/linq/webhook.ts";

const cfg = loadConfig({ ...process.env, IMESSAGE_MODE: "linq" });
setConfig(cfg);
if (!cfg.LINQ_API_KEY) {
  console.error("LINQ_API_KEY is missing. Run `npm i -g @linqapp/cli && linq signup`, then put the key in .env.");
  process.exit(1);
}
if (spawnSync("linq", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error("the linq CLI isn't installed: npm i -g @linqapp/cli");
  process.exit(1);
}

const app = await startAtlas({ cfg, names: rosterName });
const api = app.transport.linq!.api;

// Remove relay subscriptions left behind by earlier sessions (only CLI relay targets).
try {
  const subs = await api.listWebhookSubscriptions();
  const stale = subs.filter((s) => /webhook\.linqapp\.com\/relay\//.test(s.target_url));
  for (const s of stale) await api.deleteWebhookSubscription(s.id);
  if (stale.length) console.log(`removed ${stale.length} stale relay webhook(s) from earlier sessions`);
} catch (err) {
  console.warn(`couldn't check for stale relay webhooks: ${(err as Error).message}`);
}

const target = `http://127.0.0.1:${cfg.LINQ_WEBHOOK_PORT}${WEBHOOK_PATH}`;
const relay = spawn("linq", ["webhooks", "listen", "--forward-to", target], { stdio: ["ignore", "pipe", "pipe"] });
const onLine = (line: string) => {
  const secret = /(whsec_[A-Za-z0-9+/=]+)/.exec(line)?.[1];
  if (secret) {
    app.transport.linq!.setSecret(secret);
    console.log("relay connected; webhook signatures are verified with this session's secret");
    return;
  }
  // Hide successful forwards and setup chatter; show anything that looks wrong.
  if (/\[2\d\d /.test(line) || /^(Events|Webhook created|Webhook ID|Forwarding to)/i.test(line.trim()) || !line.trim()) return;
  console.log(`[relay] ${line}`);
};
for (const stream of [relay.stdout, relay.stderr]) {
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    lines.forEach(onLine);
  });
}
relay.on("exit", (code) => {
  if (!stopping) {
    console.error(`the linq relay exited (${code}); webhooks have stopped. restart npm run live.`);
    void shutdown();
  }
});
console.log(`atlas is live on linq; forwarding webhooks to ${target}. ctrl-c to stop`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Ctrl-C already reached the relay (same process group); give it time to delete its webhook
  // before anything else, or Linq keeps retrying a dead relay.
  await new Promise<void>((resolve) => {
    if (relay.exitCode !== null) return resolve();
    const t = setTimeout(() => {
      relay.kill("SIGTERM");
      resolve();
    }, 10_000);
    relay.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
  await app.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => {
  relay.kill("SIGINT");
  void shutdown();
});
