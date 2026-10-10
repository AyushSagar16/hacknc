// The main agent turn: one stateless situation in, a few tool rounds, chat bubbles out.
// History is windowed and memories are retrieved, so the prompt stays small as the chat grows.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { childLog } from "../log.ts";
import type { Figures } from "./figures.ts";
import { LlmError, type Llm, type LlmContent, type LlmPart } from "./llm.ts";
import type { ToolCtx, ToolRegistry } from "./tools.ts";

export const SYSTEM_PROMPT = readFileSync(fileURLToPath(new URL("./prompts/system.md", import.meta.url)), "utf8");

export interface AgentInput {
  llm: Llm;
  model: string;
  situation: string;
  tools: ToolRegistry;
  ctx: ToolCtx;
  signal: AbortSignal;
  maxRounds?: number;
  agentName: string;
}

export interface AgentOutput {
  bubbles: string[];
  toolCalls: { name: string; ok: boolean; error?: string }[];
  failed?: LlmError["kind"];
  guarded?: boolean;
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const log = childLog({ component: "agent", chatId: input.ctx.chat.id });
  const contents: LlmContent[] = [{ role: "user", parts: [{ text: input.situation }] }];
  const toolCalls: AgentOutput["toolCalls"] = [];
  const maxRounds = input.maxRounds ?? 4;
  let text = "";
  try {
    for (let round = 0; round <= maxRounds; round++) {
      if (input.signal.aborted && toolCalls.length === 0) throw new Error("aborted");
      const result = await input.llm.generate({
        role: "agent",
        model: input.model,
        system: SYSTEM_PROMPT,
        contents,
        tools: round < maxRounds ? input.tools.decls() : undefined,
        temperature: 0.6,
        timeoutMs: 20_000,
        thinking: "low",
        trace: { chatId: input.ctx.chat.id, turnId: input.ctx.turnId },
      });
      if (result.functionCalls.length === 0) {
        text = result.text;
        break;
      }
      contents.push({ role: "model", parts: result.parts });
      const responses: LlmPart[] = [];
      for (const call of result.functionCalls) {
        const outcome = await input.tools.run(call.name, call.args, input.ctx);
        toolCalls.push({ name: call.name, ok: outcome.ok, error: outcome.ok ? undefined : outcome.error });
        responses.push({ functionResponse: { name: call.name, id: call.id, response: outcome as unknown as Record<string, unknown> } });
      }
      contents.push({ role: "user", parts: responses });
    }
  } catch (err) {
    if ((err as Error).message === "aborted") throw err;
    const kind = err instanceof LlmError ? err.kind : "api";
    log.warn({ err: (err as Error).message, kind }, "agent call failed");
    return { bubbles: [], toolCalls, failed: kind };
  }
  return { bubbles: toBubbles(text, input.agentName), toolCalls };
}

/** NO_REPLY → nothing; blank lines split bubbles; a list stays in one bubble; at most three. */
export function toBubbles(text: string, agentName: string): string[] {
  const cleaned = text
    .replace(/\bNO_REPLY\b/g, "")
    .replace(new RegExp(`^\\s*\\[?${agentName}\\]?:\\s*`, "i"), "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * Apply the money guard to the model's bubbles. If any figure is unknown or private, the model's
 * words are dropped; tools' own posts (deterministic templates) still go out.
 */
export function guardBubbles(bubbles: string[], figures: Figures, audience: { isGroup: boolean; viewerId?: number }): { bubbles: string[]; violations: string[] } {
  const violations: string[] = [];
  for (const b of bubbles) {
    const result = figures.check(b, audience);
    for (const m of result.unknown) violations.push(`unregistered figure ${m.raw}`);
    for (const l of result.privateLeaks) violations.push(`private figure ${l.mention.raw} (${l.figure.label})`);
  }
  return violations.length ? { bubbles: [], violations } : { bubbles, violations };
}
