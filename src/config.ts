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
  GEMINI_MODEL_AGENT: optionalString.transform((v) => v ?? "gemini-3.5-flash-lite"),
  GEMINI_MODEL_GATE: optionalString.transform((v) => v ?? "gemini-3.5-flash-lite"),
  GEMINI_MODEL_EXTRACT: optionalString.transform((v) => v ?? "gemini-3.1-flash-lite"),
  GEMINI_EMBED_MODEL: optionalString.transform((v) => v ?? "gemini-embedding-2"),
  /** Tried in order when a model is overloaded or times out. */
  GEMINI_FALLBACK_MODELS: csv.transform((v) => (v.length ? v : ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3-flash-preview", "gemini-3.8-flash"])),
  LLM_MODE: optionalString.transform((v) => v ?? "live").pipe(z.enum(["live", "replay", "record", "fake"])),

  NESSIE_API_KEY: optionalString,
  NESSIE_BASE_URL: optionalString.transform((v) => v ?? "https://api.nessieisreal.com"),

  SERPAPI_API_KEY: optionalString,

  /** Trip pages: Atlas publishes each trip to Supabase and links SITE_BASE_URL/t/<uuid> in the chat. */
  SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  SITE_BASE_URL: optionalString.transform((v) => v?.replace(/\/+$/, "")),

  /**
   * Bank connect: links to SITE_BASE_URL/connect/<token> are signed with CONNECT_SECRET (the web
   * site must have the same value), and the consent page calls back PUBLIC_BASE_URL/connect-callback.
   * `npm run live` sets PUBLIC_BASE_URL to its tunnel at runtime. Missing either → local fallbacks.
   */
  CONNECT_SECRET: optionalString,
  PUBLIC_BASE_URL: optionalString.transform((v) => v?.replace(/\/+$/, "")),

  /**
   * When a group goes quiet after a human message Atlas didn't answer, follow up after this many
   * seconds to move the plan forward. 0 turns it off. Default: 150 on a real line, off in the simulator.
   */
  NUDGE_IDLE_SECONDS: optionalString.transform((v) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`expected a whole number of seconds, got "${v}"`);
    return n;
  }),

  /**
   * Message cadence: Atlas shows the typing indicator and pauses before each bubble like a person
   * texting, PACE_BASE_MS + PACE_MS_PER_CHAR per character, clamped to [PACE_MIN_MS, PACE_MAX_MS].
   * The first bubble waits at most PACE_FIRST_MAX_MS (minus the time Atlas already spent typing).
   * Tapbacks and polls never wait. PACING=off sends back to back (the simulator and tests do).
   */
  PACING: optionalString.transform((v) => v ?? "on").pipe(z.enum(["on", "off"])),
  PACE_BASE_MS: intWithDefault(400),
  PACE_MS_PER_CHAR: intWithDefault(25),
  PACE_MIN_MS: intWithDefault(600),
  PACE_MAX_MS: intWithDefault(2_500),
  PACE_FIRST_MAX_MS: intWithDefault(1_000),
  /** Quiet window before answering a message that names Atlas and reads complete (others wait 2.5 s). */
  ADDRESSED_DEBOUNCE_MS: intWithDefault(1_500),

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
