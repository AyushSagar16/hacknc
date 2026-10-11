// Gemini reads each batch of new messages and reports facts; we validate every one
// (known person, known key, well-formed value, plausible dates) before it is stored. The
// model never writes to the profile directly — src/profile/aggregate.ts decides what's true.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { addDays } from "../clock.ts";
import { childLog } from "../log.ts";
import { q, type Queryable } from "../db/pool.ts";
import { setDisplayName, type MemberRow, type MessageRow } from "../db/repos/core.ts";
import type { Llm } from "../agent/llm.ts";
import { parseCommand } from "../agent/commands.ts";
import { EXTRACTION_JSON_SCHEMA, FACT_KEYS, toFactValue, type FactKey } from "./schema.ts";
import { insertFacts, markSuperseded, type NewFact } from "./store.ts";

const PROMPT = readFileSync(fileURLToPath(new URL("../agent/prompts/extract.md", import.meta.url)), "utf8");

const rawFact = z
  .object({
    message: z.number().int(),
    about: z.string(),
    key: z.enum(FACT_KEYS),
    polarity: z.enum(["positive", "negative", "neutral"]),
    explicit: z.boolean(),
    retracts: z.boolean().default(false),
    confidence: z.number().min(0).max(1),
    quote: z.string().max(200).default(""),
  })
  .passthrough();

const rawOutput = z.object({
  facts: z.array(z.unknown()).default([]),
  tensions: z.array(z.object({ topic: z.string(), sides: z.array(z.string()) })).default([]),
});

export interface Tension {
  topic: string;
  sides: number[];
}

export interface ExtractionResult {
  factIds: number[];
  tensions: Tension[];
  rejected: number;
  failed: boolean;
}

export interface ExtractInput {
  llm: Llm;
  model: string;
  chatId: number;
  turnId?: number;
  messages: MessageRow[]; // new text messages to read
  context: MessageRow[]; // a few earlier messages for pronouns
  members: MemberRow[];
  today: string;
  timezone: string;
  agentName: string;
  label: (personId: number | null) => string;
  privateBudgetPeople?: ReadonlySet<number>;
  /** What's already known per member (resolved), so "same dates" / "same as ana" can resolve. */
  known?: ReadonlyMap<number, KnownSoFar>;
}

export interface KnownSoFar {
  earliest?: string | null;
  latest?: string | null;
  city?: string | null;
}

export async function extractFacts(input: ExtractInput, on?: Queryable): Promise<ExtractionResult> {
  const log = childLog({ component: "extract", chatId: input.chatId });
  const texts = input.messages.filter((m) => m.kind === "text" && m.person_id !== null);
  if (texts.length === 0) return { factIds: [], tensions: [], rejected: 0, failed: false };

  const names = input.members.map((m) => ({ id: m.id, first: firstName(input.label(m.id)) }));
  const prompt = [
    `today is ${input.today} (${input.timezone}). members: ${names.map((n) => n.first).join(", ")}.`,
    "",
    "# known so far (resolved; use it to resolve \"same dates\", \"same as ana\")",
    ...names.map((n) => {
      const k = input.known?.get(n.id);
      const dates = k?.earliest || k?.latest ? `${k.earliest ?? "?"} to ${k.latest ?? "?"}` : "unknown";
      return `- ${n.first}: dates ${dates}; leaving from ${k?.city ?? "unknown"}`;
    }),
    "",
    "# earlier messages (context only)",
    ...input.context.map((m) => `[${m.person_id === null ? input.agentName.toLowerCase() : input.label(m.person_id)}] ${m.text}`),
    "",
    "# new messages",
    ...texts.map((m, i) => `${i}. [${input.label(m.person_id)}] ${m.text}`),
  ].join("\n");

  let parsed: z.infer<typeof rawOutput>;
  try {
    const result = await input.llm.generate({
      role: "extract",
      model: input.model,
      system: PROMPT,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      jsonSchema: EXTRACTION_JSON_SCHEMA,
      temperature: 0,
      timeoutMs: 12_000,
      trace: { chatId: input.chatId, turnId: input.turnId },
    });
    parsed = rawOutput.parse(JSON.parse(result.text || "{}"));
  } catch (err) {
    log.warn({ err: (err as Error).message }, "extraction failed; messages will be retried next turn");
    return { factIds: [], tensions: [], rejected: 0, failed: true };
  }

  const resolvePerson = (about: string, fallback: number): number | undefined => {
    const a = about.trim().toLowerCase();
    if (!a || a === "me" || a === "i" || a === "sender") return fallback;
    return names.find((n) => n.first === firstName(a))?.id;
  };

  const facts: NewFact[] = [];
  const nameFacts: { personId: number; name: string }[] = [];
  let rejected = 0;
  const minDate = addDays(input.today, -1);
  const maxDate = addDays(input.today, 730);
  for (const item of parsed.facts) {
    const f = rawFact.safeParse(item);
    if (!f.success) {
      rejected += 1;
      continue;
    }
    const msg = texts[f.data.message];
    if (!msg || msg.person_id === null) {
      rejected += 1;
      continue;
    }
    const personId = resolvePerson(f.data.about, msg.person_id);
    const value = toFactValue(f.data.key as FactKey, f.data as Record<string, unknown>);
    if (personId === undefined || !value || !datesPlausible(value, minDate, maxDate)) {
      rejected += 1;
      continue;
    }
    // A fact about someone else needs that someone named in the message ("ana is vegetarian");
    // otherwise the model attributed it by guesswork.
    if (personId !== msg.person_id && !namesPerson(msg.text, names.find((n) => n.id === personId)?.first ?? "")) {
      rejected += 1;
      log.debug({ key: f.data.key, about: f.data.about, quote: f.data.quote }, "dropped a fact about someone not named in the message");
      continue;
    }
    const reason = noiseReason(f.data.key as FactKey, value, msg.text, personId === msg.person_id, f.data.polarity);
    if (reason) {
      rejected += 1;
      log.debug({ key: f.data.key, reason, quote: f.data.quote }, "dropped a noise fact");
      continue;
    }
    if (f.data.key === "name") {
      // Only the sender can name themselves.
      if (personId !== msg.person_id) {
        rejected += 1;
        continue;
      }
      nameFacts.push({ personId, name: capitalize(String(value.name)) });
    }
    facts.push({
      personId,
      chatId: input.chatId,
      key: f.data.key as FactKey,
      value,
      polarity: normalizePolarity(f.data.key as FactKey, f.data.polarity),
      explicit: f.data.explicit,
      confidence: f.data.confidence,
      visibility: f.data.key === "budget_comment" && input.privateBudgetPeople?.has(personId) ? "private" : "public",
      sourceMessageId: msg.id,
      quote: f.data.quote.slice(0, 120) || null,
      observedAt: msg.sent_at,
      retracted: f.data.retracts,
      reportedBy: msg.person_id,
    });
  }

  // "pittsburgh, same dates" / "same as ana": if the model gave no dates for it, copy the
  // referenced person's (or the last other speaker's) known window, as an implied fact.
  for (const [i, msg] of texts.entries()) {
    const same = sameDatesRef(msg.text);
    if (!same || msg.person_id === null) continue;
    if (facts.some((f) => f.sourceMessageId === msg.id && f.personId === msg.person_id && f.key === "date_window")) continue;
    const refName = same[1]?.toLowerCase();
    const earlier = [...input.context, ...texts.slice(0, i)].reverse();
    const refId = refName ? names.find((n) => n.first === firstName(refName))?.id : earlier.find((m) => m.person_id !== null && m.person_id !== msg.person_id && hasWindow(input.known?.get(m.person_id)))?.person_id ?? undefined;
    const window = refId !== undefined && refId !== null ? input.known?.get(refId) : undefined;
    if (!window || !hasWindow(window)) continue;
    facts.push({
      personId: msg.person_id,
      chatId: input.chatId,
      key: "date_window",
      value: { earliest: window.earliest ?? null, latest: window.latest ?? null },
      polarity: "positive",
      explicit: false,
      confidence: 0.8,
      visibility: "public",
      sourceMessageId: msg.id,
      quote: same[0].slice(0, 120),
      observedAt: msg.sent_at,
      retracted: false,
      reportedBy: msg.person_id,
    });
  }

  const factIds = await insertFacts(facts, on);
  for (const n of nameFacts) await setDisplayName(n.personId, n.name, { overwrite: true });
  await markSuperseded([...new Set(facts.map((f) => f.personId))], { chatId: input.chatId, tripId: texts[0]?.trip_id ?? undefined });

  const tensions: Tension[] = parsed.tensions
    .map((t) => ({ topic: t.topic.slice(0, 80), sides: [...new Set(t.sides.map((s) => resolvePerson(s, -1)).filter((id): id is number => id !== undefined && id !== -1))] }))
    .filter((t) => t.sides.length >= 2);

  if (rejected > 0) log.info({ rejected, kept: facts.length }, "dropped invalid extracted facts");
  return { factIds, tensions, rejected, failed: false };
}

export async function markExtracted(messageIds: number[], at: Date): Promise<void> {
  if (messageIds.length === 0) return;
  await q(`UPDATE messages SET extracted_at = $2 WHERE id = ANY($1)`, [messageIds, at]);
}

const SAME_DATES = /\bsame (?:dates?|days|time|week(?:end)?|as (?:everyone|everybody|y'?all|you guys|(\w+)))\b/i;
/**
 * "pittsburgh, same dates" / "same as ana" / "same time as everyone": a reference to someone's dates.
 * Not a question or money talk ("why is my share the same as ana's?"), and a bare "same as X"
 * only in a short message or next to date words.
 */
export function sameDatesRef(text: string): RegExpExecArray | null {
  const m = SAME_DATES.exec(text);
  if (!m || text.includes("?") || /\b(share|split|pay|paying|cost|budget|price|owe)\b/i.test(text)) return null;
  const words = text.trim().split(/\s+/).length;
  if (/^same as/i.test(m[0]) && words > 8 && !/\b(dates?|days|free|works?|week(?:end)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\d+)\b/i.test(text)) return null;
  return m;
}
const hasWindow = (k: KnownSoFar | undefined): boolean => Boolean(k && (k.earliest || k.latest));

/** The person's first name appears as a word in the text (also "ana's"). */
export function namesPerson(text: string, first: string): boolean {
  if (!first) return false;
  return new RegExp(`(^|[^\\p{L}])${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}])`, "iu").test(text);
}

/** Keys whose polarity carries no meaning: a home city, a date window or "can't fly" is just true. */
const PLAIN_KEYS: ReadonlySet<FactKey> = new Set(["home_city", "name", "date_window", "blackout", "trip_length", "dietary", "travel_limit"]);

/** The model sometimes files "omar can't fly" or "i'm in charlotte" as negative/neutral; store them as positive. */
export function normalizePolarity(key: FactKey, polarity: "positive" | "negative" | "neutral"): "positive" | "negative" | "neutral" {
  return PLAIN_KEYS.has(key) ? "positive" : polarity;
}

const FIRST_PERSON = /\b(i|i'?m|im|i'?ll|i'?ve|me|my|myself|mine)\b/i;
const QUESTION = /\?|^\W*(?:\w+\W+)?(?:what|whats|what's|how|where|which|who|any|anything|is|are|does|do|can|could|should)\b/i;

/**
 * Deterministic second opinion on facts that are usually misreads:
 * - a budget command to Atlas ("keep my budget private") is not a budget mood;
 * - a question about food or things to do ("any good vegetarian restaurants there?") says nothing
 *   about the asker's own diet or interests unless they talk about themselves.
 */
const REFUSAL = /\b(no|not|nah|never|hate|pass|skip|veto|too (?:pricey|expensive|far|cold|hot|much)|over it|rather not|don'?t|doesn'?t|won'?t|can'?t|nope|ugh)\b/i;

export function noiseReason(key: FactKey, value: Record<string, unknown>, text: string, aboutSender: boolean, polarity: "positive" | "negative" | "neutral" = "positive"): string | null {
  const t = text.trim();
  // A veto needs refusal language; "lol miami?" or a bare "miami?" is a reaction, not a no.
  if (key === "destination" && polarity === "negative") {
    if (/^\W*(?:lol|lmao|haha|omg|wait)?\W*[\p{L}\s.'-]{0,25}\?+\W*$/iu.test(t) || /^\W*(?:lol|lmao|haha)\b/i.test(t) && !REFUSAL.test(t)) return "reaction, not a veto";
    if (!REFUSAL.test(t)) return "no refusal language";
  }
  // A ceiling needs a number in the message ("can you send the updated split" isn't one).
  if (key === "budget_comment" && value.kind === "ceiling" && !/\d/.test(t)) return "ceiling without a number";
  if (key === "budget_comment" && value.kind !== "ceiling" && value.kind !== "too_expensive") {
    const cmd = parseCommand(t, { addressed: true });
    if (cmd && (cmd.kind === "budget_private" || cmd.kind === "budget_public" || cmd.kind === "budget_query" || cmd.kind === "budget_set")) return "budget command";
  }
  // "can we do somewhere with beaches?" is a wish for the group; "any veggie spots?" isn't a diet.
  const speaksForSelf = FIRST_PERSON.test(t) || (key === "activity" && /\b(we|us|our|let'?s)\b/i.test(t));
  if (aboutSender && (key === "dietary" || key === "activity") && QUESTION.test(t) && !speaksForSelf) return "question, not a preference";
  return null;
}

function datesPlausible(value: Record<string, unknown>, min: string, max: string): boolean {
  for (const k of ["earliest", "latest", "start", "end"]) {
    const d = value[k];
    if (typeof d === "string" && (d < min || d > max)) return false;
  }
  if (typeof value.start === "string" && typeof value.end === "string" && value.end < value.start) return false;
  if (typeof value.earliest === "string" && typeof value.latest === "string" && value.latest < value.earliest) return false;
  return true;
}

const firstName = (s: string) => s.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z…0-9-]/g, "") ?? "";
const capitalize = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
