// Structured logging. Keys, secrets and auth headers are redacted wherever they appear.
//
// LOG_FORMAT=json (default) writes one pino JSON object per line. LOG_FORMAT=pretty writes the same
// events as one readable line each (`npm run live` turns it on): the operator's console during a demo.
//   15:53:56 INFO  pipeline  inbound  chat=73 msg=189 from="Sakshi …4521" text="I'm driving from unc chapel hill"
// LOG_FILE always gets JSON.
import pino, { type Logger } from "pino";

const REDACT = [
  "key",
  "apiKey",
  "api_key",
  "secret",
  "token",
  "authorization",
  "headers.authorization",
  "*.key",
  "*.apiKey",
  "*.api_key",
  "*.secret",
  "*.token",
  "*.authorization",
];

const LEVELS: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO ", 40: "WARN ", 50: "ERROR", 60: "FATAL" };
/** Keys printed in this order right after the message; everything else follows as it came. */
const LEAD = ["chatId", "turnId", "msgId", "outboxId"];
const SHORT: Record<string, string> = { chatId: "chat", turnId: "turn", msgId: "msg", outboxId: "out" };

function value(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "string") return /^[\w.:/@+…-]+$/u.test(v) ? v : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null)) return v.map((x) => String(x)).join(",");
  return JSON.stringify(v);
}

/** One pino JSON line → one readable line. Anything that isn't JSON passes through unchanged. */
export function prettyLine(line: string): string {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line.endsWith("\n") ? line : `${line}\n`;
  }
  const { level, time, msg, component, pid: _pid, hostname: _host, ...rest } = o;
  const t = typeof time === "number" ? new Date(time) : new Date();
  const hh = (n: number) => String(n).padStart(2, "0");
  const clock = `${hh(t.getHours())}:${hh(t.getMinutes())}:${hh(t.getSeconds())}`;
  const parts = [clock, LEVELS[Number(level)] ?? String(level), String(component ?? "-").padEnd(9), String(msg ?? "")];
  // Empty fields (null, undefined) are left out: the line shows what happened, not what didn't.
  const keys = [...LEAD.filter((k) => k in rest), ...Object.keys(rest).filter((k) => !LEAD.includes(k))].filter((k) => rest[k] !== null && rest[k] !== undefined);
  const fields = keys.map((k) => `${SHORT[k] ?? k}=${value(rest[k])}`);
  return `${parts.join("  ")}${fields.length ? `  ${fields.join(" ")}` : ""}\n`;
}

function build(): Logger {
  const level = process.env.LOG_LEVEL ?? "info";
  const file = process.env.LOG_FILE;
  const options = { level, redact: { paths: REDACT, censor: "[redacted]" }, base: undefined };
  if (file) return pino(options, pino.destination({ dest: file, mkdir: true, sync: false }));
  // The format is read per line, so a script can switch it after modules made their loggers.
  return pino(options, { write: (line: string) => void process.stdout.write(process.env.LOG_FORMAT === "pretty" ? prettyLine(line) : line) });
}

let root: Logger = build();

export function log(): Logger {
  return root;
}

export function childLog(bindings: Record<string, unknown>): Logger {
  return root.child(bindings);
}

/** The simulator sends logs to a file so the terminal stays readable. */
export function resetLogger(): void {
  root = build();
}

/** Strip query-string secrets (e.g. Nessie's ?key=) before a URL is logged or stored. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:key|api_key|apiKey|token)=)[^&]*/g, "$1[redacted]");
}

/** A phone number or email for logs: only the last 4 characters ("+15551234567" → "…4567"). */
export function maskHandle(handle: string | null | undefined): string {
  const h = (handle ?? "").trim();
  if (!h) return "";
  const local = h.includes("@") ? h.split("@")[0]! : h.replace(/[^\dA-Za-z]/g, "");
  return `…${local.slice(-4)}`;
}

/** A message's first ~60 characters on one line, for logs. */
export function preview(text: string | null | undefined, max = 60): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
