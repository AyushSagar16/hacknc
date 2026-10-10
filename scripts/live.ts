// The real line, one command. Atlas on IMESSAGE_MODE=linq, plus a way for Linq's webhooks to
// reach this Mac:
//   default  a cloudflared quick tunnel + a Linq webhook subscription for every event Atlas uses
//            (native polls included); the subscription's signing secret verifies every delivery
//   --relay  the CLI's `linq webhooks listen` relay (no tunnel; the CLI can't subscribe to poll
//            events, so polls fall back to numbered text + tapback votes)
// Stale subscriptions from earlier sessions are removed first: leftovers made Linq deliver events
// minutes late and out of order for others.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
const has = (bin: string) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
const useRelay = process.argv.includes("--relay") || !has("cloudflared");
if (useRelay && !has("linq")) {
  console.error("need cloudflared (brew install cloudflared) or the linq CLI (npm i -g @linqapp/cli)");
  process.exit(1);
}

const EVENTS = [
  "message.received",
  "message.sent",
  "message.failed",
  "reaction.added",
  "reaction.removed",
  "poll.sent",
  "poll.failed",
  "poll.vote.added",
  "poll.vote.removed",
  "participant.added",
  "participant.removed",
  "chat.created",
];

const app = await startAtlas({ cfg, names: rosterName, console: true });
const linq = app.transport.linq!;
const api = linq.api;
console.log(`judge console: http://127.0.0.1:${cfg.CONSOLE_PORT}`);

try {
  const stale = (await api.listWebhookSubscriptions()).filter((s) => /webhook\.linqapp\.com\/relay\/|trycloudflare\.com/.test(s.target_url));
  for (const s of stale) await api.deleteWebhookSubscription(s.id);
  if (stale.length) console.log(`removed ${stale.length} stale webhook subscription(s) from earlier sessions`);
} catch (err) {
  console.warn(`couldn't check for stale webhook subscriptions: ${(err as Error).message}`);
}

const local = `http://127.0.0.1:${cfg.LINQ_WEBHOOK_PORT}`;
let child: ChildProcess;
let subscriptionId: string | undefined;
let stopping = false;

const lines = (proc: ChildProcess, onLine: (line: string) => void) => {
  for (const stream of [proc.stdout!, proc.stderr!]) {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      parts.forEach(onLine);
    });
  }
};

if (!useRelay) {
  child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", local], { stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("cloudflared didn't print a tunnel URL within 30s")), 30_000);
    lines(child, (line) => {
      const m = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/.exec(line);
      if (m) {
        clearTimeout(t);
        resolve(m[1]!);
      } else if (/ERR|error/i.test(line) && !/no such host|retrying/i.test(line)) console.log(`[tunnel] ${line.trim()}`);
    });
  });
  // Wait until the tunnel actually reaches our server (it answers GET with 404).
  for (let i = 0; i < 30; i++) {
    const ok = await fetch(`${url}${WEBHOOK_PATH}`, { signal: AbortSignal.timeout(4_000) }).then((r) => r.status === 404).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const created = await api.call<{ id: string; signing_secret?: string; secret?: string }>(`/webhook-subscriptions`, {
    body: { target_url: `${url}${WEBHOOK_PATH}`, subscribed_events: EVENTS },
  });
  subscriptionId = created.id;
  const secret = created.signing_secret ?? created.secret;
  if (!secret) throw new Error("Linq didn't return a signing secret for the subscription");
  linq.setSecret(secret);
  console.log(`atlas is live on linq through a tunnel (native polls on); every delivery is signature-checked. ctrl-c to stop`);
} else {
  linq.setNativePolls(false);
  child = spawn("linq", ["webhooks", "listen", "--forward-to", `${local}${WEBHOOK_PATH}`], { stdio: ["ignore", "pipe", "pipe"] });
  lines(child, (line) => {
    const secret = /(whsec_[A-Za-z0-9+/=]+)/.exec(line)?.[1];
    if (secret) {
      linq.setSecret(secret);
      console.log("relay connected; webhook signatures are verified with this session's secret");
      return;
    }
    if (/\[2\d\d /.test(line) || /^(Events|Webhook created|Webhook ID|Forwarding to)/i.test(line.trim()) || !line.trim()) return;
    console.log(`[relay] ${line}`);
  });
  console.log(`atlas is live on linq through the CLI relay (text polls). ctrl-c to stop`);
}

child.on("exit", (code) => {
  if (!stopping) {
    console.error(`the ${useRelay ? "linq relay" : "tunnel"} exited (${code}); webhooks have stopped. restart npm run live.`);
    void shutdown();
  }
});

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 15_000).unref();
  if (subscriptionId) await api.deleteWebhookSubscription(subscriptionId).catch(() => {});
  // The relay deletes its own webhook on SIGINT; give it time before anything else.
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    const t = setTimeout(() => {
      child.kill("SIGTERM");
      resolve();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill("SIGINT");
  });
  await app.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
