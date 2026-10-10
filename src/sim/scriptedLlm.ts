// An LLM whose answers come from the scenario script (`~gate SPEAK`, `~agent call tool {...}`),
// falling back to safe defaults (gate silent, nothing extracted, agent NO_REPLY). Scenarios can
// then pin down exactly what the deterministic code does with a given model answer, offline.
import { LlmError, callResult, hashEmbed, jsonResult, textResult, type GenerateRequest, type GenerateResult, type Llm, type LlmRole } from "../agent/llm.ts";

export type Scripted = (req: GenerateRequest) => GenerateResult;

export class ScriptedLlm implements Llm {
  private readonly queues = new Map<LlmRole, Scripted[]>();
  readonly calls: GenerateRequest[] = [];
  /** When set, unscripted calls go to a real model instead of the defaults (hybrid mode). */
  constructor(private readonly fallback?: Llm) {}

  push(role: LlmRole, answer: Scripted): void {
    this.queues.set(role, [...(this.queues.get(role) ?? []), answer]);
  }

  pending(): { role: LlmRole; count: number }[] {
    return [...this.queues].filter(([, q]) => q.length > 0).map(([role, q]) => ({ role, count: q.length }));
  }

  clear(): void {
    this.queues.clear();
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    const next = this.queues.get(req.role)?.shift();
    if (next) return next(req);
    if (this.fallback) return this.fallback.generate(req);
    switch (req.role) {
      case "gate":
        return jsonResult({ decision: "NO_REPLY", reason: "unscripted" });
      case "extract":
        return jsonResult({ facts: [], tensions: [] });
      case "agent":
        return textResult("NO_REPLY");
      default:
        throw new LlmError(`unscripted ${req.role}`, "timeout");
    }
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<number[][]> {
    return this.fallback ? this.fallback.embed(texts, kind) : hashEmbed(texts, kind);
  }
}

/** Parse the body of a `~role ...` script line into an answer. */
export function parseScripted(role: LlmRole, body: string): Scripted {
  const b = body.trim();
  if (role === "gate") {
    const [decision, ...reason] = b.split(/\s+/);
    const d = decision?.toUpperCase() === "SPEAK" ? "SPEAK" : "NO_REPLY";
    return () => jsonResult({ decision: d, reason: reason.join(" ") || "scripted" });
  }
  if (role === "extract") {
    const value = JSON.parse(b) as unknown;
    return () => jsonResult(Array.isArray(value) ? { facts: value, tensions: [] } : value);
  }
  if (b.startsWith("call ")) {
    const match = /^call\s+(\w+)\s*(.*)$/.exec(b);
    if (!match) throw new Error(`bad scripted call: ${b}`);
    const args = match[2] ? (JSON.parse(match[2]) as Record<string, unknown>) : {};
    return () => callResult(match[1]!, args);
  }
  const text = b.replace(/^text:\s*/, "").replace(/\\n/g, "\n");
  return () => textResult(text);
}
