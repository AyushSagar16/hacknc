// Adapted from ethanyanghq/scout src/scout/speak_gate.py (SpeakGate) @ 60f567b89916edb908129c868e3dd4be664b0e07
// Original author: Ethan Yang — used and adapted with the author's explicit permission.
// Changes: structured JSON verdict {decision, reason} at temperature 0 instead of a prefix match;
// a hard timeout; deterministic hints (stuck decision, deadline, new constraint) and the unprompted
// budget are part of the situation; the prompt is rewritten for a trip + money planner.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { childLog } from "../log.ts";
import type { Llm } from "./llm.ts";

export const GATE_PROMPT = readFileSync(fileURLToPath(new URL("./prompts/speak-gate.md", import.meta.url)), "utf8");
export const RECENT_MESSAGE_COUNT = 12;

const verdictSchema = z.object({ decision: z.enum(["SPEAK", "NO_REPLY"]), reason: z.string().default("").transform((r) => r.slice(0, 200)) });

const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["SPEAK", "NO_REPLY"] },
    reason: { type: "string" },
  },
  required: ["decision", "reason"],
};

export interface GateSituation {
  atlasHasSpoken: boolean;
  stage: string;
  facts: string[];
  hints: string[];
  minutesSinceAtlasSpoke: number | null;
  unpromptedLastHour: number;
  recent: { label: string; text: string }[];
  newest: { label: string; text: string }[];
}

export interface GateVerdict {
  speak: boolean;
  reason: string;
  failed: boolean;
}

export function describeGateSituation(s: GateSituation): string {
  const where = [
    `atlas has spoken in this chat: ${s.atlasHasSpoken ? "yes" : "no"}`,
    `trip stage: ${s.stage}`,
    ...s.facts,
    `atlas last spoke: ${s.minutesSinceAtlasSpoke === null ? "never" : `${s.minutesSinceAtlasSpoke} min ago`}`,
    `unprompted atlas messages in the last hour: ${s.unpromptedLastHour}`,
  ];
  return [
    "# where things stand",
    ...where,
    "",
    "# hints",
    ...(s.hints.length ? s.hints.map((h) => `- ${h}`) : ["- none"]),
    "",
    "# latest messages, oldest first",
    ...s.recent.map((m) => `[${m.label}] ${m.text}`),
    "",
    "# newest message(s)",
    ...s.newest.map((m) => `From ${m.label}: ${m.text}`),
  ].join("\n");
}

export async function speakGate(
  llm: Llm,
  model: string,
  situation: GateSituation,
  trace?: { chatId?: number; turnId?: number },
): Promise<GateVerdict> {
  try {
    const result = await llm.generate({
      role: "gate",
      model,
      system: GATE_PROMPT,
      contents: [{ role: "user", parts: [{ text: describeGateSituation(situation) }] }],
      jsonSchema: VERDICT_JSON_SCHEMA,
      temperature: 0,
      timeoutMs: 3_500,
      maxOutputTokens: 120,
      trace,
    });
    const verdict = readVerdict(result.text);
    if (!verdict) {
      childLog({ component: "gate" }).warn({ text: result.text.slice(0, 120) }, "unreadable gate verdict; staying quiet");
      return { speak: false, reason: "unreadable verdict", failed: true };
    }
    return { speak: verdict.decision === "SPEAK", reason: verdict.reason, failed: false };
  } catch (err) {
    // Fail closed: if the gate can't decide, nobody asked Atlas anything.
    childLog({ component: "gate" }).warn({ err: (err as Error).message }, "speak gate failed; staying quiet");
    return { speak: false, reason: `gate error: ${(err as Error).message.slice(0, 80)}`, failed: true };
  }
}

/**
 * Read the verdict even when a fallback model wraps it in prose ("Here is the JSON: {...}") or a
 * code fence. Seen live: a failover model answered that way and every gate call failed closed.
 */
export function readVerdict(text: string): z.infer<typeof verdictSchema> | null {
  const t = (text ?? "").trim();
  const candidates = [t, /\{[\s\S]*\}/.exec(t)?.[0]].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      const parsed = verdictSchema.safeParse(JSON.parse(c));
      if (parsed.success) return parsed.data;
    } catch {
      // try the next shape
    }
  }
  // Last resort: a bare decision word in an otherwise unreadable answer.
  const word = /"?decision"?\s*:\s*"?(SPEAK|NO_REPLY)\b/i.exec(t)?.[1] ?? /^\W*(SPEAK|NO_REPLY)\b/i.exec(t)?.[1];
  return word ? { decision: word.toUpperCase() as "SPEAK" | "NO_REPLY", reason: "" } : null;
}
