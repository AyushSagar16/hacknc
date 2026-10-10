// Gemini Flash reads each batch of new messages and reports facts; we validate every one
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
}

export async function extractFacts(input: ExtractInput, on?: Queryable): Promise<ExtractionResult> {
  const log = childLog({ component: "extract", chatId: input.chatId });
  const texts = input.messages.filter((m) => m.kind === "text" && m.person_id !== null);
  if (texts.length === 0) return { factIds: [], tensions: [], rejected: 0, failed: false };

  const names = input.members.map((m) => ({ id: m.id, first: firstName(input.label(m.id)) }));
  const prompt = [
    `today is ${input.today} (${input.timezone}). members: ${names.map((n) => n.first).join(", ")}.`,
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
      polarity: f.data.polarity,
      explicit: f.data.explicit,
      confidence: f.data.confidence,
      visibility: f.data.key === "budget_comment" && input.privateBudgetPeople?.has(personId) ? "private" : "public",
      sourceMessageId: msg.id,
      quote: f.data.quote.slice(0, 120) || null,
      observedAt: msg.sent_at,
      retracted: f.data.retracts,
    });
  }

  const factIds = await insertFacts(facts, on);
  for (const n of nameFacts) await setDisplayName(n.personId, n.name, { overwrite: true });
  await markSuperseded([...new Set(facts.map((f) => f.personId))]);

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
