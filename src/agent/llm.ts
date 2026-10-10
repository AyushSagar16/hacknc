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

export type LlmRole = "gate" | "agent" | "extract" | "summary";

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
  trace?: { chatId?: number; turnId?: number };
}

export interface GenerateResult {
  text: string;
  functionCalls: { name: string; args: Record<string, unknown>; id?: string }[];
  /** The model's parts exactly as returned (thought signatures included) to append to history. */
  parts: LlmPart[];
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

export class GeminiLlm implements Llm {
  private readonly ai: GoogleGenAI;
  private readonly log = childLog({ component: "llm.gemini" });

  constructor(
    apiKey: string,
    private readonly embedModel: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const signal = AbortSignal.timeout(req.timeoutMs);
    try {
      const response = await this.ai.models.generateContent({
        model: req.model,
        contents: req.contents as never,
        config: {
          systemInstruction: req.system,
          temperature: req.temperature,
          maxOutputTokens: req.maxOutputTokens,
          abortSignal: signal,
          ...(req.tools?.length
            ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] }
            : {}),
          ...(req.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema } : {}),
          ...(req.thinking ? { thinkingConfig: { thinkingLevel: THINKING[req.thinking] } } : {}),
        },
      });
      const candidate = response.candidates?.[0];
      const parts = (candidate?.content?.parts ?? []) as LlmPart[];
      if (!candidate || parts.length === 0) {
        const reason = candidate?.finishReason ?? response.promptFeedback?.blockReason ?? "no candidates";
        throw new LlmError(`gemini returned nothing (${reason})`, String(reason).includes("SAFETY") ? "refused" : "empty");
      }
      return toResult(parts);
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (signal.aborted) throw new LlmError(`gemini ${req.role} call timed out after ${req.timeoutMs}ms`, "timeout");
      this.log.warn({ role: req.role, err: (err as Error).message }, "gemini call failed");
      throw new LlmError((err as Error).message, "api");
    }
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    if (texts.length === 0) return [];
    // gemini-embedding-2 takes the task as a text prefix; gemini-embedding-001 takes taskType.
    const prefixed = this.embedModel.startsWith("gemini-embedding-2")
      ? texts.map((t) => (kind === "query" ? `task: search result | query: ${t}` : `title: none | text: ${t}`))
      : texts;
    const response = await this.ai.models.embedContent({
      model: this.embedModel,
      contents: prefixed,
      config: {
        outputDimensionality: EMBED_DIM,
        abortSignal: AbortSignal.timeout(10_000),
        ...(this.embedModel.startsWith("gemini-embedding-2") ? {} : { taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" }),
      },
    });
    const vectors = (response.embeddings ?? []).map((e) => normalize(e.values ?? []));
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBED_DIM)) {
      throw new LlmError(`embedding returned ${vectors.length} vectors of ${vectors[0]?.length ?? 0} dims`, "api");
    }
    return vectors;
  }
}

const THINKING = { minimal: ThinkingLevel.MINIMAL, low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM } as const;

function toResult(parts: LlmPart[]): GenerateResult {
  const text = parts
    .filter((p): p is { text: string; thought?: boolean } => "text" in p && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
  const functionCalls = parts.filter((p): p is Extract<LlmPart, { functionCall: unknown }> => "functionCall" in p).map((p) => p.functionCall);
  return { text, functionCalls, parts };
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
      void trace(req, Date.now() - t0, result.text.slice(0, 120), null);
      return result;
    } catch (err) {
      void trace(req, Date.now() - t0, null, (err as Error).message);
      throw err;
    }
  }

  embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    return this.inner.embed(texts, kind);
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

export function createLlm(opts: { mode: "live" | "replay" | "record" | "fake"; apiKey?: string; embedModel: string; cassette?: string }): Llm {
  if (opts.mode === "fake") return new FakeLlm();
  const live = opts.apiKey ? new TracedLlm(new GeminiLlm(opts.apiKey, opts.embedModel)) : undefined;
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
