// Atlas, the trip and financial planner that lives in a group chat.
// `npm start` runs it on the line chosen by IMESSAGE_MODE (default linq). For a Linq line with
// the CLI relay, prefer `npm run live`, which also supervises `linq webhooks listen`.
// `npm run sim` runs it against a simulated group with no phones.
import { config } from "./config.ts";
import { childLog } from "./log.ts";
import { startAtlas } from "./app.ts";
import { rosterName } from "./roster.ts";

const cfg = config();
const log = childLog({ component: "main" });
const app = await startAtlas({ cfg, names: rosterName, console: true });
console.log(`atlas is listening (${cfg.IMESSAGE_MODE}). judge console: http://127.0.0.1:${cfg.CONSOLE_PORT}`);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  await app.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
await app.done;
