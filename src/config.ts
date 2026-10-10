// Typed, validated configuration. Every variable here is listed in .env.example.
// Secrets are only ever read from process.env and never logged (see log.ts redaction).
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const csv = optionalString.transform((v) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const intWithDefault = (fallback: number) =>
  optionalString.transform((v) => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`expected an integer, got "${v}"`);
    return n;
  });

const schema = z.object({
  IMESSAGE_MODE: optionalString.transform((v) => v ?? "linq").pipe(z.enum(["linq", "local", "cloud", "sim"])),
  AGENT_NAME: optionalString.transform((v) => v ?? "Atlas"),

  PROJECT_ID: optionalString,
  PROJECT_SECRET: optionalString,

  LINQ_API_KEY: optionalString,
  LINQ_API_URL: optionalString.transform((v) => v ?? "https://api.linqapp.com/api/partner/v3"),
  LINQ_WEBHOOK_PORT: intWithDefault(8788),
  LINQ_WEBHOOK_MODE: optionalString.transform((v) => v ?? "relay").pipe(z.enum(["relay", "subscription"])),
  LINQ_WEBHOOK_SECRET: optionalString,

  DATABASE_URL: optionalString.transform((v) => v ?? "postgres://atlas:atlas@localhost:54329/atlas"),
  DATABASE_POOL_MAX: intWithDefault(5),

  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL_AGENT: optionalString.transform((v) => v ?? "gemini-3.8-flash"),
  GEMINI_MODEL_GATE: optionalString.transform((v) => v ?? "gemini-3.5-flash-lite"),
  GEMINI_MODEL_EXTRACT: optionalString.transform((v) => v ?? "gemini-3.8-flash"),
  GEMINI_EMBED_MODEL: optionalString.transform((v) => v ?? "gemini-embedding-2"),
  /** Tried in order when a model is overloaded or times out. */
  GEMINI_FALLBACK_MODELS: csv.transform((v) => (v.length ? v : ["gemini-3.6-flash", "gemini-3.5-flash-lite"])),
  LLM_MODE: optionalString.transform((v) => v ?? "live").pipe(z.enum(["live", "replay", "record", "fake"])),

  NESSIE_API_KEY: optionalString,
  NESSIE_BASE_URL: optionalString.transform((v) => v ?? "https://api.nessieisreal.com"),

  SERPAPI_API_KEY: optionalString,

  ALLOWED_CHATS: csv,
  OPERATOR_HANDLES: csv,
  CONSOLE_PORT: intWithDefault(8790),
  DEFAULT_TIMEZONE: optionalString.transform((v) => v ?? "America/New_York"),
  LOG_LEVEL: optionalString.transform((v) => v ?? "info"),
  LOG_FILE: optionalString,
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Tests and the simulator override configuration explicitly. */
export function setConfig(next: Config): void {
  cached = next;
}
