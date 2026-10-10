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

const verdictSchema = z.object({ decision: z.enum(["SPEAK", "NO_REPLY"]), reason: z.string().max(200).default("") });

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
    const parsed = verdictSchema.safeParse(JSON.parse(result.text || "{}"));
    if (!parsed.success) {
      return { speak: false, reason: "unreadable verdict", failed: true };
    }
    return { speak: parsed.data.decision === "SPEAK", reason: parsed.data.reason, failed: false };
  } catch (err) {
    // Fail closed: if the gate can't decide, nobody asked Atlas anything.
    childLog({ component: "gate" }).warn({ err: (err as Error).message }, "speak gate failed; staying quiet");
    return { speak: false, reason: `gate error: ${(err as Error).message.slice(0, 80)}`, failed: true };
  }
}
