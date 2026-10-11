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
  /** Someone named Atlas or replied to it: silence is not an acceptable answer. */
  mustAnswer?: boolean;
}

export interface KnownFields {
  /** Lowercase first name. */
  name: string;
  dates: boolean;
  city: boolean;
}

export interface AgentOutput {
  bubbles: string[];
  /** A tool whose post stands alone ran successfully. */
  soloPosted?: boolean;
  toolCalls: { name: string; ok: boolean; error?: string }[];
  failed?: LlmError["kind"];
  guarded?: boolean;
  /** The model never produced words (only thoughts, or NO_REPLY when it had to answer), even after a retry. */
  empty?: boolean;
  /** The model was nudged once after an empty answer. */
  retried?: boolean;
}

/** Sent once when the model answered with nothing at all (Gemini sometimes returns only thought parts). */
export const EMPTY_NUDGE = "(your last answer came back empty. reply to the group now in 1–2 short lines, or NO_REPLY if there is truly nothing to add.)";
/** Sent once when the model said NO_REPLY to someone who named it directly. */
export const ADDRESSED_NUDGE = "(someone tagged you by name, so NO_REPLY isn't an option. answer them now in 1–2 short lines: what you know, or the one thing you need from whom.)";

/** Sent once when the model promised an action ("let me look…") without calling a tool. */
export const PROMISE_NUDGE =
  "(you just said you'd do something, but you didn't call any tool, and nothing happens after this message: you can't come back later. call the tool for it now, or answer directly with what you already know. don't announce what you're about to do.)";

/** "let me look", "one sec", "pulling options", "i'll check": doing something now. Only a broken promise when no tool ran. */
const DOING_NOW =
  /\b(?:let me (?!know\b)|lemme |one sec\b|one moment\b|give me a (?:sec|second|moment|minute)\b|hang on\b|hold on\b|pulling\b|i'?ll (?:look|check|pull|find|search|get|grab|dig|see|round up|put together|set (?:that|it|those) up)\b|i'?m (?:going to|gonna) (?:look|check|pull|find|search|start looking)\b|checking\b|looking (?:into|for|up)\b|searching\b|working on (?:it|that|those|beach|some|a few|options)\b|on it\b)/i;
/** "i'll keep trying and let you know": Atlas has no later, so this is never true. */
const LATER =
  /\b(?:i'?ll (?:keep trying|try again later|let (?:you|y'?all|everyone) know|get back to you|circle back|follow up|update you|report back|keep an eye)|will let you know|get back to you|stay tuned)\b/i;

export function promisesAction(text: string, toolRan: boolean): boolean {
  const t = text.replace(/\bNO_REPLY\b/g, "");
  return LATER.test(t) || (!toolRan && DOING_NOW.test(t));
}

/** Drop the sentences that make a promise, keep the rest ("search timed out. i'll keep trying" → "search timed out."). */
export function dropPromises(text: string, toolRan: boolean): string {
  return filterSentences(text, (sentence) => !promisesAction(sentence, toolRan));
}

/** Keep the sentences that pass, preserving bubbles (blank lines) and line breaks (lists). */
function filterSentences(text: string, keep: (sentence: string) => boolean): string {
  return text
    .split(/\n\s*\n/)
    .map((bubble) =>
      bubble
        .split("\n")
        .map((line) =>
          line
            .split(/(?<=[.!?])\s+/)
            .filter(keep)
            .join(" ")
            .trim(),
        )
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean)
    .join("\n\n");
}

const DATE_CLAIM = /\b(dates?|free|available|works? for (?:him|her|them)|can do|is set|are set|is in for|are in for)\b/i;
const CITY_CLAIM = /\b(?:leaving|flying|driving|coming|departing|heading) (?:from|out of)\b|\bhome city\b|\bbased in\b/i;
/** Sentences that talk about what's missing rather than claiming it's known. */
const ABOUT_MISSING = /\?|\b(still need|need|missing|waiting|haven'?t|hasn'?t|not yet|unknown|when|what|which|if|once|unless|not sure|ask)\b/i;

/**
 * Cut sentences that state someone's dates or home city when the situation has neither ("ravi's
 * dates are set too" when ravi only said "philly"). Scoped to those two fields to avoid false hits.
 */
export function dropUnknownClaims(text: string, known: KnownFields[]): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const out = filterSentences(text, (sentence) => {
    if (ABOUT_MISSING.test(sentence)) return true;
    for (const k of known) {
      if (!k.name || !new RegExp(`\\b${k.name}\\b`, "i").test(sentence)) continue;
      if ((!k.dates && DATE_CLAIM.test(sentence)) || (!k.city && CITY_CLAIM.test(sentence))) {
        dropped.push(sentence);
        return false;
      }
    }
    return true;
  });
  return { text: dropped.length ? out : text, dropped };
}

/**
 * Generic tail offers ("anything else you want to check before we head out?", "want me to look for
 * a few more or is that enough?") that the group never asked for. One is dropped from the end of a
 * reply; a real question that unblocks the plan ("maya, which dates work?") is left alone.
 */
const TAIL_OFFER =
  /\b(?:anything else|any other questions|what else|or is that enough|is that enough|let me know if|lmk if|want me to (?:check|look(?: for| up| into)?|find|pull|dig up|search|grab|add|set up) (?:anything|something|a few|some|more|any) ?(?:else|more)?|need anything else|does that help|hope that helps|happy to help)\b/i;

export function dropTailOffer(bubbles: string[]): string[] {
  if (bubbles.length === 0) return bubbles;
  const out = [...bubbles];
  const last = out[out.length - 1]!;
  const sentences = last.split(/(?<=[.!?])\s+/);
  const tail = sentences[sentences.length - 1] ?? "";
  if (!TAIL_OFFER.test(tail)) return out;
  const kept = sentences.slice(0, -1).join(" ").trim();
  // A reply that is only the offer stays (the model had nothing else to say).
  if (!kept && out.length === 1) return out;
  if (kept) out[out.length - 1] = kept;
  else out.pop();
  return out;
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const log = childLog({ component: "agent", chatId: input.ctx.chat.id });
  const contents: LlmContent[] = [{ role: "user", parts: [{ text: input.situation }] }];
  const toolCalls: AgentOutput["toolCalls"] = [];
  const toolNames = input.tools.decls().map((d) => d.name);
  const outStart = input.ctx.out.length;
  let soloPosted = false;
  const maxRounds = input.maxRounds ?? 4;

  /** Tool rounds until the model writes text (or a solo post ends the turn). Returns the text. */
  const converse = async (rounds: number, thinking: "minimal" | "low"): Promise<{ text: string; ended: boolean }> => {
    for (let round = 0; round <= rounds; round++) {
      if (input.signal.aborted && toolCalls.length === 0) throw new Error("aborted");
      const result = await input.llm.generate({
        role: "agent",
        model: input.model,
        system: SYSTEM_PROMPT,
        contents,
        tools: round < rounds ? input.tools.decls() : undefined,
        temperature: 0.6,
        timeoutMs: 20_000,
        thinking,
        trace: { chatId: input.ctx.chat.id, turnId: input.ctx.turnId },
      });
      if (result.functionCalls.length === 0) {
        // Keep the model's visible words in the transcript so a nudge reads as a follow-up.
        if (result.text) contents.push({ role: "model", parts: [{ text: result.text }] });
        return { text: result.text, ended: false };
      }
      contents.push({ role: "model", parts: result.parts });
      const responses: LlmPart[] = [];
      let allSolo = true;
      for (const call of result.functionCalls) {
        const before = input.ctx.out.length;
        const outcome = await input.tools.run(call.name, call.args, input.ctx);
        toolCalls.push({ name: call.name, ok: outcome.ok, error: outcome.ok ? undefined : outcome.error });
        responses.push({ functionResponse: { name: call.name, id: call.id, response: outcome as unknown as Record<string, unknown> } });
        // "Solo" only counts when the tool actually posted: ask_for_missing_info posts nothing when
        // everyone was already asked, and then the model's own words are the whole reply.
        const posted = outcome.ok && input.tools.isSolo(call.name) && input.ctx.out.length > before;
        soloPosted ||= posted;
        allSolo &&= posted;
      }
      // A post that stands alone needs no lead-in, and any words the model added would be dropped
      // (brain.ts), so don't spend another call asking for them.
      if (allSolo) return { text: "", ended: true };
      contents.push({ role: "user", parts: responses });
    }
    return { text: "", ended: false };
  };

  /** Append a nudge to the conversation as the user's next words. */
  const nudge = (text: string) => {
    const last = contents[contents.length - 1]!;
    if (last.role === "user") contents[contents.length - 1] = { ...last, parts: [...last.parts, { text }] };
    else contents.push({ role: "user", parts: [{ text }] });
  };

  let text = "";
  let retried = false;
  try {
    const first = await converse(maxRounds, "low");
    text = first.text;
    const toolPosted = input.ctx.out.length > outStart;
    if (!first.ended && !toolPosted && toBubbles(text, input.agentName, toolNames).length === 0) {
      // Empty text that isn't a deliberate NO_REPLY is a model hiccup (thoughts only), not a choice.
      // NO_REPLY to someone who named Atlas is a choice it isn't allowed to make.
      const explicitNoReply = /\bNO_REPLY\b/.test(text);
      const why = !explicitNoReply ? EMPTY_NUDGE : input.mustAnswer ? ADDRESSED_NUDGE : undefined;
      if (why) {
        retried = true;
        log.info({ explicitNoReply, mustAnswer: Boolean(input.mustAnswer) }, "agent answer was empty; nudging once");
        nudge(why);
        const second = await converse(Math.min(2, maxRounds), "minimal");
        text = second.text;
      }
    }
    // A promise with nothing behind it ("got it, let me look for beach spots under 800." and no tool
    // call) leaves the group waiting forever: ask once for the tool call or a direct answer.
    if (!soloPosted && promisesAction(text, toolCalls.length > 0)) {
      retried = true;
      log.info({ text: text.slice(0, 120), tools: toolCalls.length }, "agent promised an action it didn't take; nudging once");
      nudge(PROMISE_NUDGE);
      const promised = text;
      try {
        const again = await converse(Math.min(2, maxRounds), "minimal");
        text = again.text;
      } catch (err) {
        if ((err as Error).message === "aborted") throw err;
        log.warn({ err: (err as Error).message }, "promise follow-up call failed; sending what was there minus the promise");
        text = promised;
      }
      // Never send a bare promise: whatever is still a promise is cut.
      text = dropPromises(text, toolCalls.length > 0);
    }
  } catch (err) {
    if ((err as Error).message === "aborted") throw err;
    const kind = err instanceof LlmError ? err.kind : "api";
    log.warn({ err: (err as Error).message, kind }, "agent call failed");
    return { bubbles: [], toolCalls, failed: kind, retried };
  }
  const bubbles = dropTailOffer(toBubbles(text, input.agentName, toolNames));
  const empty = bubbles.length === 0 && !soloPosted && input.ctx.out.length === outStart && (retried || !/\bNO_REPLY\b/.test(text));
  return { bubbles, toolCalls, soloPosted, empty, retried };
}

/**
 * NO_REPLY → nothing; blank lines split bubbles; a list (and its "…:" lead-in) stays in one bubble; at most three.
 * Small models sometimes write a tool call as text ("default_api:show_budgets{}"); that never
 * reaches the chat.
 */
export function toBubbles(text: string, agentName: string, toolNames: string[] = []): string[] {
  let cleaned = text;
  if (toolNames.length) {
    // An optional namespace ("default_api.", "setDefaultApi:"), a tool name, then {…} or (…).
    const names = toolNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const call = `(?:\\b[A-Za-z_]\\w*[:.])?\\b(?:${names})\\s*(?:\\{[^{}]*\\}|\\([^()]*\\))`;
    cleaned = cleaned
      .replace(/```\w*\n?[\s\S]*?```/g, (block) => (new RegExp(call).test(block) ? "" : block))
      .replace(new RegExp(call, "g"), "");
  }
  cleaned = cleaned
    // Tag-shaped leftovers of a call: <call:…>, </call:default_api>, <tool_call>…
    .replace(/<\/?(?:call|tool_call|function_call|tool_code)\b[^>]*>|<\/?[\w:]*default_api[^>]*>/gi, "")
    .replace(/\bNO_REPLY\b/g, "")
    .replace(new RegExp(`^\\s*\\[?${agentName}\\]?:\\s*`, "i"), "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .trim();
  if (!cleaned) return [];
  const parts = cleaned
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  // A lead-in that ends in ":" belongs with the list after it ("top spots:" + "- skybridge…"):
  // split apart, an untagged reply (one bubble) would send a dangling "here's what to do:".
  const merged: string[] = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && prev.endsWith(":")) merged[merged.length - 1] = `${prev}\n${p}`;
    else merged.push(p);
  }
  return merged.slice(0, 3);
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
