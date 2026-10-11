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
import { isSmallTalk } from "./smallTalk.ts";

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
  /** Lowercase first names, to tell a question for one friend from one for the room. */
  memberNames?: string[];
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
      // Thinking failover models spent a 120-token budget thinking and wrote only "Here is the",
      // which failed every gate call closed. Minimal thinking and room for the JSON fix that.
      thinking: "minimal",
      maxOutputTokens: 400,
      trace,
    });
    const verdict = readVerdict(result.text);
    if (!verdict) {
      const fallback = gateFallback(situation);
      childLog({ component: "gate" }).warn({ text: result.text.slice(0, 120), fallback }, "unreadable gate verdict; using the deterministic fallback");
      return { speak: fallback !== null, reason: fallback ?? "unreadable verdict", failed: true };
    }
    return { speak: verdict.decision === "SPEAK", reason: verdict.reason, failed: false };
  } catch (err) {
    // The gate couldn't decide (quota, timeout). Banter stays quiet, but a message about the trip or
    // money still gets an answer: silence on a real question is what makes Atlas look broken.
    const fallback = gateFallback(situation);
    childLog({ component: "gate" }).warn({ err: (err as Error).message, fallback }, "speak gate failed; using the deterministic fallback");
    return { speak: fallback !== null, reason: fallback ?? `gate error: ${(err as Error).message.slice(0, 80)}`, failed: true };
  }
}

/** When the gate model is unavailable: speak on anything that needs Atlas or is about the trip/money. */
export function gateFallback(s: Pick<GateSituation, "newest" | "memberNames">): string | null {
  for (const m of [...s.newest].reverse()) {
    const why = roomNeedsAtlas(m.text, s.memberNames ?? []);
    if (why) return `${m.label.toLowerCase().split(/\s+/)[0]} ${why}`;
  }
  for (const m of [...s.newest].reverse()) {
    if (!isSmallTalk(m.text) && !aimedAtSomeone(m.text, s.memberNames ?? []) && TRIP_WORDS.test(m.text)) return `${m.label.toLowerCase().split(/\s+/)[0]} shared trip details: say what it unlocks or who's still missing`;
  }
  return null;
}

const TRIP_WORDS =
  /\b(trip|there|place|spot|go|going|stay|staying|hotel|airbnb|flights?|fly|flying|drive|driving|gas|car|weather|temps?|temperature|cold|warm|rain|snow|forecast|pack|eat|food|restaurants?|vegan|vegetarian|things to do|activities|events?|festivals?|dates?|week|weekend|budgets?|cost|costs|price|prices|pricey|expensive|cheap|cheaper|split|share|shares|pay|paying|paid|owe|owes|money|total|plan|itinerary|book|booking|vote|poll|options?|destination|leave|leaving|free|available|availability|busy|schedule|voted|votes|beach(?:es)?|mountains?|hike|hiking|ski|skiing|lake|camping|cabin|resort|hostel|cruise|road ?trip|airport|passport|tickets?|dinner|lunch|breakfast|brunch|drinks|bar|bars|uber|lyft|taxi|receipt|bill|tip|venmo|zelle|refund|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|break)\b|\$\d|\b\d{2,}\b/i;
const QUESTION_START = /^\W*(?:(?:ok|okay|so|wait|hmm+|and|but|also|actually|ya|yeah)\W+)*(?:what|what'?s|whats|how|how'?s|where|when|why|which|who|is|are|can|could|should|would|will|do|does|any|anyone|anything)\b/i;
const OBJECTION = /\b(too (?:expensive|pricey|much|far|long|cold|hot)|can'?t afford|out of (?:my|our) (?:budget|price range)|over (?:my|our) budget|not in my budget|i'?m (?:so )?broke|that'?s a lot for me)\b/i;
const CHANGE_OF_MIND = /\b(instead|switch(?:ing)? to|change (?:it )?to|rather (?:go|do)|what about|how about|can we (?:do|go to|try|switch)|let'?s do)\b/i;

/** Anything about the trip or money (places, dates, travel, food, costs, the plan). */
export function mentionsTrip(text: string): boolean {
  return TRIP_WORDS.test(text ?? "");
}

/** "maya do u have a car", "ravi, are you in?", "…right, kim?": a question for one friend, not the room. */
export function aimedAtSomeone(text: string, memberNames: readonly string[]): boolean {
  const names = memberNames.map((n) => n.toLowerCase()).filter((n) => /^[a-z]{2,}$/.test(n));
  if (names.length === 0) return false;
  const alt = names.join("|");
  return new RegExp(`^\\W*(?:${alt})\\b(?:\\s*[,:]|\\s+(?:do|did|are|r|can|could|will|would|u|you|have|pls|please|when|what|where))`, "i").test(text) || new RegExp(`[,]\\s*(?:${alt})\\W*$`, "i").test(text.trim());
}

/**
 * Messages that must reach the agent without asking the gate: a trip or money question to the room
 * ("how is the split calculated?", "what's the typical high and low temp there tho"), an objection
 * ("that's too expensive for me") or a change of mind ("can we do asheville instead?"). Returns the
 * reason handed to the agent, or null.
 */
export function roomNeedsAtlas(text: string, memberNames: readonly string[]): string | null {
  const t = (text ?? "").trim();
  if (!t || isSmallTalk(t) || aimedAtSomeone(t, memberNames)) return null;
  if (OBJECTION.test(t)) return `objected ("${t.slice(0, 60)}"): acknowledge it and offer the next step (budgets, cheaper options or a different split)`;
  if (CHANGE_OF_MIND.test(t) && (t.includes("?") || TRIP_WORDS.test(t))) return `wants to change the plan ("${t.slice(0, 60)}"): acknowledge it and turn it into a quick group decision`;
  const question = t.includes("?") || QUESTION_START.test(t);
  if (question && TRIP_WORDS.test(t)) return `asked the room a trip/money question ("${t.slice(0, 60)}"): answer it in a line or two`;
  return null;
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
