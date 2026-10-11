// The one door to language models. Everything Atlas asks Gemini goes through `Llm`, so
// tests can script answers (FakeLlm), scenarios can replay recorded answers (cassettes),
// and every call is timed, bounded and traced. Gemini only does language here: callers
// validate every structured answer before acting on it.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { now } from "../clock.ts";
import { childLog } from "../log.ts";
import { q } from "../db/pool.ts";

export type LlmRole = "gate" | "agent" | "extract" | "summary" | "search";

/** Gemini's built-in tools: Google Search grounding, and reading pages the prompt names. */
export type BuiltinTool = "googleSearch" | "urlContext";

export interface LlmSource {
  uri: string;
  title?: string;
}

export type LlmPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { functionCall: { name: string; args: Record<string, unknown>; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

export interface LlmContent {
  role: "user" | "model";
  parts: LlmPart[];
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface GenerateRequest {
  role: LlmRole;
  model: string;
  system: string;
  contents: LlmContent[];
  tools?: ToolDecl[];
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  timeoutMs: number;
  maxOutputTokens?: number;
  thinking?: "minimal" | "low" | "medium";
  /** Built-in tools to enable (grounded lookups). Health is tracked separately per tool set. */
  builtinTools?: BuiltinTool[];
  /**
   * Total wall-clock budget across the whole failover chain (each attempt still gets at most
   * timeoutMs). With a budget, a chain whose models are all benched by a short quota 429 waits
   * for the first one to come back instead of hammering them, as long as that fits the budget.
   */
  budgetMs?: number;
  trace?: { chatId?: number; turnId?: number };
}

export interface GenerateResult {
  /** The model that actually answered (after any failover). */
  model?: string;
  text: string;
  functionCalls: { name: string; args: Record<string, unknown>; id?: string }[];
  /** The model's parts exactly as returned (thought signatures included) to append to history. */
  parts: LlmPart[];
  /**
   * Pages a built-in tool used: Google Search grounding chunks (often vertexaisearch redirect
   * URLs; resolve before showing anyone) and pages urlContext fetched successfully.
   */
  sources?: LlmSource[];
}

export interface Llm {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "api" | "refused" | "empty" | "no_key" | "replay_miss",
  ) {
    super(message);
  }
}

export const EMBED_DIM = 768;

// ---------- Gemini ----------

const OVERLOADED = /\b(503|500|502|504|429)\b|UNAVAILABLE|high demand|overloaded|RESOURCE_EXHAUSTED|INTERNAL|DEADLINE/i;
const NOT_FOUND = /\b404\b|NOT_FOUND|is not found|not supported for generateContent|no longer available/i;
const QUOTA = /\b429\b|RESOURCE_EXHAUSTED|quota/i;
const BAD_KEY = /API_KEY_INVALID|API key not valid|API key expired|\b403\b|PERMISSION_DENIED/i;
const BAD_THINKING = /thinking/i;

/** GEMINI_API_KEY holds one key or several, comma-separated. */
export function splitKeys(keys: string | string[] | undefined): string[] {
  const list = Array.isArray(keys) ? keys : (keys ?? "").split(",");
  return [...new Set(list.map((k) => k.trim()).filter(Boolean))];
}

/** One attempt: a model on one API key. */
interface Slot {
  model: string;
  key: number;
}

export class GeminiLlm implements Llm {
  /** One client per API key. Quota is per Google project, so each key has its own buckets. */
  private readonly clients: GoogleGenAI[];
  private nextKey = 0;
  private readonly log = childLog({ component: "llm.gemini" });
  /**
   * Buckets that just failed are skipped until this time. `bucket` benches a model on every key
   * (overload, timeouts and missing models are Google's side); `bucket@k` benches it on key k
   * only (that key's quota ran out); `*@k` benches key k for everything (it was rejected).
   */
  private readonly unhealthyUntil = new Map<string, number>();
  private readonly noThinking = new Set<string>();

  constructor(
    apiKeys: string | string[],
    private readonly embedModel: string,
    private readonly fallbacks: string[] = [],
  ) {
    const keys = splitKeys(apiKeys);
    if (keys.length === 0) throw new Error("GeminiLlm needs at least one API key");
    this.clients = keys.map((apiKey) => new GoogleGenAI({ apiKey }));
  }

  /** Every key, starting from the next one in turn, so calls are spread across the keys. */
  private keyRotation(): number[] {
    const n = this.clients.length;
    const start = this.nextKey++ % n;
    return Array.from({ length: n }, (_, i) => (start + i) % n);
  }

  private keyLabel(k: number): string {
    return this.clients.length > 1 ? ` (key ${k + 1})` : "";
  }

  private dueAt(bucket: string, k: number): number {
    const at = (h: string) => this.unhealthyUntil.get(h) ?? 0;
    return Math.max(at(bucket), at(`${bucket}@${k}`), at(`*@${k}`));
  }

  private markUnhealthy(bucket: string, ms: number, why: string, k?: number): void {
    this.unhealthyUntil.set(k === undefined ? bucket : `${bucket}@${k}`, Date.now() + ms);
    const scope = k === undefined ? (this.clients.length > 1 ? "all keys" : undefined) : this.clients.length > 1 ? `key ${k + 1}` : undefined;
    this.log.warn({ model: bucket, ...(scope ? { scope } : {}), why: why.slice(0, 120), skipForSec: Math.round(ms / 1000) }, "gemini model unhealthy; failing over");
  }

  /**
   * Bench whatever the error says is broken: a rejected key everywhere, a spent quota on that key
   * only (another key's project still has its own), anything else on every key.
   */
  private bench(bucket: string, k: number, err: unknown, ms = benchMs(err)): void {
    const msg = (err as Error)?.message ?? String(err);
    if (BAD_KEY.test(msg) && !QUOTA.test(msg)) this.markUnhealthy("*", 60 * 60_000, msg, k);
    else if (QUOTA.test(msg)) this.markUnhealthy(bucket, ms, msg, k);
    else this.markUnhealthy(bucket, ms, msg);
  }

  /** Ping each model on each key once so a dead model or spent key is skipped from the first real message. */
  async warmup(models: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const slots = [...new Set(models)].flatMap((model) => this.clients.map((_, key) => ({ model, key })));
    await Promise.all(
      slots.map(async ({ model, key }) => {
        const label = `${model}${this.keyLabel(key)}`;
        const t0 = Date.now();
        try {
          await this.once({ role: "summary", model, system: "reply ok", contents: [{ role: "user", parts: [{ text: "ping" }] }], timeoutMs: 8_000, maxOutputTokens: 5 }, model, false, key);
          out[label] = `ok ${Date.now() - t0}ms`;
        } catch (err) {
          // Thinking models can spend the tiny ping budget before writing anything (MAX_TOKENS).
          // That still proves the model is up and has quota, so it isn't a reason to skip it.
          if (err instanceof LlmError && err.kind === "empty") {
            out[label] = `ok ${Date.now() - t0}ms`;
            return;
          }
          this.bench(model, key, err);
          out[label] = `unhealthy: ${(err as Error).message.slice(0, 60)}`;
        }
      }),
    );
    return out;
  }

  /**
   * Try the requested model on each key, then each fallback the same way, skipping anything that
   * failed recently. Overload (503/429/timeouts) fails over; a model that rejects the thinking
   * setting is retried without it.
   */
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const chain = [req.model, ...this.fallbacks.filter((m) => m !== req.model)];
    const keys = this.keyRotation();
    const slots: Slot[] = chain.flatMap((model) => keys.map((key) => ({ model, key })));
    const bucket = (m: string) => bucketKey(m, req.builtinTools);
    const due = (s: Slot) => this.dueAt(bucket(s.model), s.key);
    const t0 = Date.now();
    const remaining = () => (req.budgetMs === undefined ? Number.POSITIVE_INFINITY : req.budgetMs - (Date.now() - t0));
    let usable = slots.filter((s) => due(s) < Date.now());
    if (usable.length === 0 && req.budgetMs !== undefined) {
      // Everything is benched (usually a per-minute 429). Back off until the first model is due
      // back if that still leaves time for a real attempt; otherwise fail fast so the caller can
      // fall back instead of burning its whole budget on calls that will 429 again.
      const soonest = Math.min(...slots.map(due));
      const wait = Math.max(0, soonest - Date.now());
      if (wait + MIN_ATTEMPT_MS > remaining()) throw new LlmError(`all models busy for ${Math.round(wait / 1000)}s more`, "api");
      this.log.info({ role: req.role, waitMs: wait }, "all gemini models benched; backing off");
      await sleep(wait);
      usable = slots.filter((s) => due(s) < Date.now());
    }
    const order = usable.length ? usable : slots;
    const startedAt = Date.now();
    let last: unknown;
    for (const [i, slot] of order.entries()) {
      const { model, key } = slot;
      // Something benched during this call (the model on every key, or this key) isn't retried.
      if (last !== undefined && due(slot) > startedAt) continue;
      const isLast = i === order.length - 1;
      const left = remaining();
      if (left < MIN_ATTEMPT_MS && last !== undefined) break;
      // With somewhere to fall back to, don't wait the full budget on a struggling model.
      const timeoutMs = Math.max(1_000, Math.min(isLast ? req.timeoutMs : Math.min(req.timeoutMs, 12_000), left));
      try {
        return await this.once({ ...req, timeoutMs }, model, !this.noThinking.has(model), key);
      } catch (err) {
        last = err;
        const msg = (err as Error).message;
        if (err instanceof LlmError && (err.kind === "refused" || err.kind === "empty")) throw err;
        if (BAD_THINKING.test(msg) && /400|INVALID_ARGUMENT/.test(msg) && req.thinking) {
          this.noThinking.add(model);
          try {
            return await this.once({ ...req, timeoutMs }, model, false, key);
          } catch (retryErr) {
            last = retryErr;
          }
        }
        const lastMsg = (last as Error).message;
        // A budgeted call that times out on a model has learned it's too slow right now: bench it
        // briefly so the next call starts on another model instead of timing out the same way.
        const hung = last instanceof LlmError && last.kind === "timeout" && (timeoutMs >= 10_000 || req.budgetMs !== undefined);
        if (hung) this.bench(bucket(model), key, last, timeoutMs >= 10_000 ? benchMs(last) : 45_000);
        else if (OVERLOADED.test(lastMsg) || NOT_FOUND.test(lastMsg) || BAD_KEY.test(lastMsg)) this.bench(bucket(model), key, last);
        else if (!isLast) this.log.warn({ model, err: lastMsg.slice(0, 160) }, "gemini call failed; trying the next model");
      }
    }
    throw last instanceof LlmError ? last : new LlmError((last as Error)?.message ?? "gemini failed", "api");
  }

  private async once(req: GenerateRequest, model: string, withThinking: boolean, key = 0): Promise<GenerateResult> {
    const signal = AbortSignal.timeout(req.timeoutMs);
    try {
      const response = await this.clients[key]!.models.generateContent({
        model,
        contents: req.contents as never,
        config: {
          systemInstruction: req.system,
          temperature: req.temperature,
          maxOutputTokens: req.maxOutputTokens,
          abortSignal: signal,
          ...(req.tools?.length || req.builtinTools?.length
            ? {
                tools: [
                  ...(req.tools?.length ? [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] : []),
                  ...(req.builtinTools ?? []).map((t) => ({ [t]: {} })),
                ],
              }
            : {}),
          ...(req.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema } : {}),
          ...(req.thinking && withThinking ? { thinkingConfig: { thinkingLevel: THINKING[req.thinking] } } : {}),
        },
      });
      const candidate = response.candidates?.[0];
      const parts = (candidate?.content?.parts ?? []) as LlmPart[];
      if (!candidate || parts.length === 0) {
        const reason = candidate?.finishReason ?? response.promptFeedback?.blockReason ?? "no candidates";
        throw new LlmError(`gemini returned nothing (${reason})`, String(reason).includes("SAFETY") ? "refused" : "empty");
      }
      const result: GenerateResult = { ...toResult(parts), model };
      if (req.builtinTools?.length) result.sources = sourcesOf(candidate);
      return result;
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (signal.aborted) throw new LlmError(`gemini ${model}${this.keyLabel(key)} ${req.role} call timed out after ${req.timeoutMs}ms`, "timeout");
      throw new LlmError((err as Error).message, "api");
    }
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    if (texts.length === 0) return [];
    // gemini-embedding-2 takes the task as a text prefix; gemini-embedding-001 takes taskType.
    const prefixed = this.embedModel.startsWith("gemini-embedding-2")
      ? texts.map((t) => (kind === "query" ? `task: search result | query: ${t}` : `title: none | text: ${t}`))
      : texts;
    const keys = this.keyRotation();
    const usable = keys.filter((k) => this.dueAt(this.embedModel, k) < Date.now());
    let last: unknown;
    for (const key of usable.length ? usable : keys) {
      try {
        return await this.embedOnce(prefixed, kind, key);
      } catch (err) {
        last = err;
        const msg = (err as Error).message;
        // Only a spent or rejected key is worth trying another key for.
        if (!QUOTA.test(msg) && !BAD_KEY.test(msg)) throw err;
        this.bench(this.embedModel, key, err);
      }
    }
    throw last;
  }

  private async embedOnce(prefixed: string[], kind: "query" | "document", key: number): Promise<number[][]> {
    const response = await this.clients[key]!.models.embedContent({
      model: this.embedModel,
      // One Content per text: gemini-embedding-2 reads a bare string array as the parts of a
      // single input and returns one vector for all of them.
      contents: prefixed.map((text) => ({ role: "user", parts: [{ text }] })),
      config: {
        outputDimensionality: EMBED_DIM,
        abortSignal: AbortSignal.timeout(10_000),
        ...(this.embedModel.startsWith("gemini-embedding-2") ? {} : { taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" }),
      },
    });
    const vectors = (response.embeddings ?? []).map((e) => normalize(e.values ?? []));
    if (vectors.length !== prefixed.length || vectors.some((v) => v.length !== EMBED_DIM)) {
      throw new LlmError(`embedding returned ${vectors.length} vectors of ${vectors[0]?.length ?? 0} dims`, "api");
    }
    return vectors;
  }
}

/** Below this, another attempt can't finish (a urlContext read alone takes a few seconds). */
const MIN_ATTEMPT_MS = 2_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Which quota bucket a call draws from. Google Search grounding has its own (a 429 there must not
 * bench the model for chat), but urlContext and plain calls share the model's per-minute request
 * quota: a 429 on one means the other will 429 too, so they share a health key.
 */
export function bucketKey(model: string, builtinTools?: BuiltinTool[]): string {
  return builtinTools?.includes("googleSearch") ? `${model}+googleSearch` : model;
}

const THINKING = { minimal: ThinkingLevel.MINIMAL, low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM } as const;

/**
 * How long to skip a model after a failure. A quota 429 says how long to wait (RetryInfo), and a
 * daily quota won't come back for hours, so neither is retried on the overload schedule.
 */
export function benchMs(err: unknown): number {
  const msg = (err as Error)?.message ?? String(err);
  if (err instanceof LlmError && err.kind === "timeout") return 3 * 60_000;
  if (NOT_FOUND.test(msg)) return 60 * 60_000;
  if (QUOTA.test(msg)) {
    if (/PerDay/i.test(msg)) return 30 * 60_000;
    const delay = /"?retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(msg);
    if (delay) return Math.max(15_000, Math.ceil(Number(delay[1]) * 1000));
    return 60_000;
  }
  return 2 * 60_000;
}

function toResult(parts: LlmPart[]): GenerateResult {
  const text = parts
    .filter((p): p is { text: string; thought?: boolean } => "text" in p && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
  const functionCalls = parts.filter((p): p is Extract<LlmPart, { functionCall: unknown }> => "functionCall" in p).map((p) => p.functionCall);
  return { text, functionCalls, parts };
}

/** Grounding chunks first (search results), then pages urlContext read; deduped, in order. */
function sourcesOf(candidate: { groundingMetadata?: unknown; urlContextMetadata?: unknown }): LlmSource[] {
  const out: LlmSource[] = [];
  const seen = new Set<string>();
  const add = (uri: unknown, title: unknown) => {
    if (typeof uri !== "string" || !/^https?:\/\//.test(uri) || seen.has(uri)) return;
    seen.add(uri);
    out.push(typeof title === "string" && title ? { uri, title } : { uri });
  };
  const g = candidate.groundingMetadata as { groundingChunks?: { web?: { uri?: string; title?: string } }[] } | undefined;
  for (const c of g?.groundingChunks ?? []) add(c.web?.uri, c.web?.title);
  const u = candidate.urlContextMetadata as { urlMetadata?: { retrievedUrl?: string; urlRetrievalStatus?: string }[] } | undefined;
  for (const m of u?.urlMetadata ?? []) if (String(m.urlRetrievalStatus ?? "").includes("SUCCESS")) add(m.retrievedUrl, undefined);
  return out;
}

export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

// ---------- Tracing wrapper ----------

/** Records every call's role, model, latency and outcome in llm_traces (shown in the console). */
export class TracedLlm implements Llm {
  constructor(private readonly inner: Llm) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const t0 = Date.now();
    try {
      const result = await this.inner.generate(req);
      void trace({ ...req, model: result.model ?? req.model }, Date.now() - t0, result.text.slice(0, 120), null);
      return result;
    } catch (err) {
      void trace(req, Date.now() - t0, null, (err as Error).message);
      throw err;
    }
  }

  embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    return this.inner.embed(texts, kind);
  }

  warmup(models: string[]): Promise<Record<string, string>> {
    return this.inner instanceof GeminiLlm ? this.inner.warmup(models) : Promise.resolve({});
  }
}

async function trace(req: GenerateRequest, ms: number, decision: string | null, error: string | null): Promise<void> {
  try {
    await q(`INSERT INTO llm_traces (role, model, chat_id, turn_id, latency_ms, decision, error, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      req.role,
      req.model,
      req.trace?.chatId ?? null,
      req.trace?.turnId ?? null,
      ms,
      decision,
      error,
      now(),
    ]);
  } catch {
    // tracing is best-effort
  }
}

// ---------- Cassettes (record / replay) ----------

interface CassetteEntry {
  role: LlmRole;
  n: number;
  promptHash: string;
  result?: GenerateResult;
  embed?: number[][];
  error?: { message: string; kind: LlmError["kind"] };
}

/**
 * Scenario tests replay recorded answers, keyed by (role, call number within the scenario).
 * The prompt hash is only a drift warning: prompts contain timestamps and ids that vary.
 */
export class CassetteLlm implements Llm {
  private entries: CassetteEntry[] = [];
  private counters = new Map<string, number>();
  private readonly log = childLog({ component: "llm.cassette" });
  drift = 0;

  constructor(
    private readonly path: string,
    private readonly mode: "record" | "replay",
    private readonly live?: Llm,
  ) {}

  async load(): Promise<void> {
    if (this.mode === "record") return;
    this.entries = JSON.parse(await readFile(this.path, "utf8")) as CassetteEntry[];
  }

  async save(): Promise<void> {
    if (this.mode !== "record") return;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.entries, null, 1)}\n`);
  }

  private next(role: string): number {
    const n = this.counters.get(role) ?? 0;
    this.counters.set(role, n + 1);
    return n;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const n = this.next(req.role);
    const promptHash = hashPrompt(req);
    if (this.mode === "record") {
      try {
        const result = await this.live!.generate(req);
        this.entries.push({ role: req.role, n, promptHash, result });
        return result;
      } catch (err) {
        const kind = err instanceof LlmError ? err.kind : "api";
        this.entries.push({ role: req.role, n, promptHash, error: { message: (err as Error).message, kind } });
        throw err;
      }
    }
    const entry = this.entries.find((e) => e.role === req.role && e.n === n);
    if (!entry) throw new LlmError(`cassette ${this.path} has no ${req.role} call #${n}`, "replay_miss");
    if (entry.promptHash !== promptHash) this.drift += 1;
    if (entry.error) throw new LlmError(entry.error.message, entry.error.kind);
    return entry.result!;
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    // Embeddings are deterministic per text; tests use the hash embedder instead of recording them.
    return hashEmbed(texts, kind);
  }
}

function hashPrompt(req: GenerateRequest): string {
  const stable = JSON.stringify({ s: req.system.length, c: req.contents.map((c) => c.parts.length), t: req.tools?.map((t) => t.name) });
  return createHash("sha1").update(stable).digest("hex").slice(0, 12);
}

// ---------- Fakes ----------

export type FakeHandler = (req: GenerateRequest) => GenerateResult | Promise<GenerateResult>;

/** Unit tests script each role's answers. Unscripted roles fail closed like a timeout would. */
export class FakeLlm implements Llm {
  readonly calls: GenerateRequest[] = [];

  constructor(private readonly handlers: Partial<Record<LlmRole, FakeHandler>> = {}) {}

  set(role: LlmRole, handler: FakeHandler): this {
    this.handlers[role] = handler;
    return this;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    const handler = this.handlers[req.role];
    if (!handler) throw new LlmError(`no fake answer for ${req.role}`, "timeout");
    return handler(req);
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    return hashEmbed(texts, kind);
  }
}

export const textResult = (text: string): GenerateResult => ({ text, functionCalls: [], parts: [{ text }] });
export const jsonResult = (value: unknown): GenerateResult => textResult(JSON.stringify(value));
export const callResult = (name: string, args: Record<string, unknown>): GenerateResult => ({
  text: "",
  functionCalls: [{ name, args }],
  parts: [{ functionCall: { name, args } }],
});

/**
 * Deterministic bag-of-words embedding: texts sharing words land close together. Good enough
 * to test retrieval scoping and ranking without a model; never used for real memory.
 */
export function hashEmbed(texts: string[], _kind: "query" | "document"): number[][] {
  return texts.map((t) => {
    const v = new Array<number>(EMBED_DIM).fill(0);
    for (const word of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (STOP.has(word)) continue;
      const h = createHash("md5").update(word).digest();
      v[h.readUInt16BE(0) % EMBED_DIM]! += 1;
      v[h.readUInt16BE(2) % EMBED_DIM]! += 0.5;
    }
    return normalize(v);
  });
}

const STOP = new Set(["the", "a", "an", "to", "of", "and", "is", "i", "we", "for", "in", "on", "it", "that", "what", "did", "about", "say", "said"]);

export function createLlm(opts: { mode: "live" | "replay" | "record" | "fake"; apiKey?: string; embedModel: string; fallbacks?: string[]; cassette?: string }): Llm {
  if (opts.mode === "fake") return new FakeLlm();
  const keys = splitKeys(opts.apiKey);
  const live = keys.length ? new TracedLlm(new GeminiLlm(keys, opts.embedModel, opts.fallbacks ?? [])) : undefined;
  if (opts.mode === "live") {
    if (!live) return new NoKeyLlm();
    return live;
  }
  return new CassetteLlm(opts.cassette ?? "test/cassettes/default.json", opts.mode, live);
}

/** Without a Gemini key Atlas still runs: deterministic commands, money and polls work; language fails closed. */
export class NoKeyLlm implements Llm {
  async generate(): Promise<GenerateResult> {
    throw new LlmError("GEMINI_API_KEY is not set", "no_key");
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    return hashEmbed(texts, kind);
  }
}
