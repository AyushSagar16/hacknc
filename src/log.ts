// Structured logging. Keys, secrets and auth headers are redacted wherever they appear.
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

function build(): Logger {
  const level = process.env.LOG_LEVEL ?? "info";
  const file = process.env.LOG_FILE;
  const options = { level, redact: { paths: REDACT, censor: "[redacted]" }, base: undefined };
  if (file) return pino(options, pino.destination({ dest: file, mkdir: true, sync: false }));
  return pino(options);
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
