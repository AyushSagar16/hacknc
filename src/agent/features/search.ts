// web_search: look something up online and post it so it reads well in iMessage. The agent picks
// a purpose; a separate, tightly prompted Gemini call does the reading, and code does the
// formatting, so every list looks the same however the model phrased it.
//   things_to_do / food / events → the tool posts a numbered list (and at most one source link,
//                                   which iMessage renders as a rich preview); soloPost.
//   dates                         → structured {start, end, confidence, source} for set_trip_dates.
//   facts                         → a short answer the agent relays in its own words.
// Lookups go through Google Search grounding when GEMINI_SEARCH_GROUNDING=1 (it needs a paid
// tier; free keys get an instant 429) and otherwise through a keyless search (DuckDuckGo results)
// plus Gemini's urlContext reading the top pages. Results are cached for six hours.
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { Config } from "../../config.ts";
import { childLog } from "../../log.ts";
import type { Feature, TurnCtx } from "../feature.ts";
import { LlmError, type GenerateResult, type Llm, type LlmSource } from "../llm.ts";
import { say, str, type Tool, type ToolCtx } from "../tools.ts";
import { cleanAnswer, formatList, MAX_ITEMS, stripArtifacts, type ListItem } from "../../search/format.ts";
import { ddgSearch, isGroundingRedirect, linkable, resolveRedirect, type Fetch, type WebResult } from "../../search/web.ts";

export const PURPOSES = ["things_to_do", "food", "events", "dates", "facts"] as const;
export type Purpose = (typeof PURPOSES)[number];
const LIST_PURPOSES: ReadonlySet<Purpose> = new Set(["things_to_do", "food", "events"]);

export const SEARCH_TIMEOUT_MS = 12_000;
export const CACHE_TTL_MS = 6 * 3_600_000;
const PAGES_TO_READ = 4;

const log = childLog({ component: "search" });

// ---------- seams (tests) ----------

let searchFetch: Fetch | undefined;
/** Tests inject a fake fetch for the web search and redirect resolution; undefined restores the global. */
export function setSearchFetch(f: Fetch | undefined): void {
  searchFetch = f;
}
const currentFetch = (): Fetch => searchFetch ?? ((input, init) => globalThis.fetch(input, init));

const cache = new LRUCache<string, Promise<Lookup>>({ max: 300, ttl: CACHE_TTL_MS });
export function clearSearchCache(): void {
  cache.clear();
}

// ---------- results ----------

export type Lookup =
  | { kind: "list"; heading: string; items: ListItem[]; source?: string }
  | { kind: "dates"; start: string | null; end: string | null; confidence: "high" | "medium" | "low"; note: string; source?: string }
  | { kind: "facts"; answer: string; source?: string };

export interface LookupInput {
  query: string;
  purpose: Purpose;
  /** Lines about the group and trip that should shape the answer (preferences, dates, place). */
  context: string[];
  today: string;
  /** The trip's destination, if known: a fallback page (Wikivoyage) when web search is blocked. */
  place?: string;
  trace?: { chatId?: number; turnId?: number };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-27" for a date in fall 2026, "2025-26" for spring 2026: what "winter break" most likely means. */
export function academicYear(today: string): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const start = m >= 7 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

export const normalizeQuery = (q: string): string =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export function cacheKey(input: Pick<LookupInput, "query" | "purpose" | "context">): string {
  const ctx = input.context.length ? createHash("sha1").update(input.context.join("\n")).digest("hex").slice(0, 10) : "-";
  return `${input.purpose}|${normalizeQuery(input.query)}|${ctx}`;
}

// ---------- prompts ----------

const VOICE = "write like a friend texting: lowercase, plain words, no markdown, no asterisks, no emoji, no citation marks, no urls, no prices or dollar amounts.";

function systemPrompt(purpose: Purpose, today: string): string {
  const base = `you look things up for a group of friends planning a trip together. today is ${today}. only state what the pages or search results support; never invent places, dates or details. ${VOICE}`;
  switch (purpose) {
    case "things_to_do":
    case "food":
    case "events": {
      const what = purpose === "food" ? "places to eat" : purpose === "events" ? "events or seasonal happenings" : "things to do";
      return `${base}
return ${MAX_ITEMS} ${what} (at least 3) that best fit this group and their dates, best first. each item: "name" is the short name people actually use, 1 to 4 words (e.g. "ober mountain", not "ober mountain adventure park and ski area"); "detail" is one specific, complete phrase of 3 to 8 words (under 55 characters) saying what to do there or why it fits, with a concrete fact when the pages give one (e.g. "skiing and tubing, 10 min up the tramway"); no filler words like "enjoy", "experience", "safely", "everywhere". pick for the group's preferences but don't mention anyone by name. prefer things open or happening on their dates. respect dietary needs and anything someone ruled out. "heading" is a short lowercase title like "top ${what} in gatlinburg in december". "source" is the number of the result that helped most (0 if none).`;
    }
    case "dates":
      return `${base}
the question is about a date range (a school break, a festival, a season). find the next occurrence that has not ended yet as of today. for a school's winter break, use the academic calendar for the ${academicYear(today)} academic year: start is the day after the last fall final exam (or the official first day of break), end is the day before spring classes begin. dates are yyyy-mm-dd. confidence is "high" only if an official calendar says so for that year, "medium" if inferred from a close source, "low" if guessed (then leave start/end empty). "note" says in a few words what the range is from (e.g. "last fall exam dec 11, spring classes start jan 6"). "source" is the number of the result you used (0 if none).`;
    case "facts":
      return `${base}
answer in one or two short sentences. "source" is the number of the result you used (0 if none).`;
  }
}

function schemaFor(purpose: Purpose): Record<string, unknown> {
  const source = { type: "integer", description: "number of the result used most, 0 if none" };
  if (LIST_PURPOSES.has(purpose)) {
    return {
      type: "object",
      properties: {
        heading: { type: "string" },
        items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, detail: { type: "string" } }, required: ["name", "detail"] } },
        source,
      },
      required: ["heading", "items"],
    };
  }
  if (purpose === "dates") {
    return {
      type: "object",
      properties: { start: { type: "string" }, end: { type: "string" }, confidence: { type: "string", enum: ["high", "medium", "low"] }, note: { type: "string" }, source },
      required: ["start", "end", "confidence", "note"],
    };
  }
  return { type: "object", properties: { answer: { type: "string" }, source }, required: ["answer"] };
}

/** What we actually search for: the question, sharpened for the purpose. */
export function searchQueryFor(input: Pick<LookupInput, "query" | "purpose" | "today">): string {
  const q = input.query.trim();
  if (input.purpose === "dates" && !/\b20\d\d\b/.test(q)) return `${q} ${academicYear(input.today)} academic calendar`;
  return q;
}

function userPrompt(input: LookupInput, results: WebResult[]): string {
  const lines = [`question: ${input.query}`];
  if (input.context.length) lines.push("", "about the group (fit the answer to them):", ...input.context.map((c) => `- ${c}`));
  if (results.length) {
    lines.push("", `search results (read the pages at these urls for details):`);
    results.forEach((r, i) => lines.push(`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`));
  }
  return lines.join("\n");
}

// ---------- parsing ----------

function parseJson(text: string): Record<string, unknown> | null {
  const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Validate the model's JSON for this purpose; null if unusable. */
export function parseLookup(purpose: Purpose, text: string, today: string): Lookup | null {
  const j = parseJson(text);
  if (!j) return null;
  if (LIST_PURPOSES.has(purpose)) {
    const items = (Array.isArray(j.items) ? j.items : [])
      .map((it) => (it && typeof it === "object" ? (it as Record<string, unknown>) : {}))
      .map((it) => ({ name: str(it.name) ?? "", detail: str(it.detail) }))
      .filter((it) => it.name);
    if (items.length === 0) return null;
    return { kind: "list", heading: str(j.heading) ?? "", items };
  }
  if (purpose === "dates") {
    let start = str(j.start) ?? null;
    let end = str(j.end) ?? null;
    let confidence = (["high", "medium", "low"] as const).find((c) => c === j.confidence) ?? "low";
    if (!start || !end || !ISO.test(start) || !ISO.test(end) || start > end) {
      start = null;
      end = null;
      confidence = "low";
    } else if (end < today) confidence = "low"; // a range that's already over isn't the one they mean
    return { kind: "dates", start, end, confidence, note: cleanAnswer(str(j.note) ?? "", 200) };
  }
  const answer = cleanAnswer(str(j.answer) ?? "");
  return answer ? { kind: "facts", answer } : null;
}

function sourceIndex(text: string): number {
  const j = parseJson(text);
  const n = typeof j?.source === "number" ? j.source : Number(j?.source);
  return Number.isInteger(n) ? n : 0;
}

// ---------- the lookup ----------

/** Google Search grounding is only tried when enabled; after a quota error it rests for six hours. */
let groundingOffUntil = 0;
const groundingEnabled = () => process.env.GEMINI_SEARCH_GROUNDING === "1" && Date.now() >= groundingOffUntil;

async function grounded(llm: Llm, cfg: Config, input: LookupInput): Promise<{ result: GenerateResult; results: WebResult[] } | null> {
  if (!groundingEnabled()) return null;
  try {
    const result = await llm.generate({
      role: "search",
      model: cfg.GEMINI_MODEL_AGENT,
      system: systemPrompt(input.purpose, input.today),
      contents: [{ role: "user", parts: [{ text: userPrompt(input, []) }] }],
      builtinTools: ["googleSearch"],
      jsonSchema: schemaFor(input.purpose),
      temperature: 0.2,
      timeoutMs: 9_000,
      thinking: "minimal",
      trace: input.trace,
    });
    // Grounding chunks are numbered in the order the model saw them, like the keyless results.
    const results = (result.sources ?? []).map((s: LlmSource) => ({ title: s.title ?? "", url: s.uri, snippet: "" }));
    return { result, results };
  } catch (err) {
    const msg = (err as Error).message;
    if (/\b429\b|RESOURCE_EXHAUSTED|quota|\b400\b|INVALID_ARGUMENT/i.test(msg)) groundingOffUntil = Date.now() + CACHE_TTL_MS;
    log.warn({ err: msg.slice(0, 160) }, "grounded search failed; using keyless search");
    return null;
  }
}

async function keyless(llm: Llm, cfg: Config, input: LookupInput): Promise<{ result: GenerateResult; results: WebResult[] }> {
  let results: WebResult[] = [];
  try {
    results = (await ddgSearch(searchQueryFor(input), { fetch: currentFetch(), timeoutMs: 4_000 })).slice(0, PAGES_TO_READ);
  } catch (err) {
    log.warn({ err: (err as Error).message.slice(0, 120) }, "web search failed");
  }
  if (results.length === 0 && input.place && LIST_PURPOSES.has(input.purpose)) {
    const page = input.place.split(",")[0]!.trim().replace(/\s+/g, "_");
    results = [{ title: `${input.place} travel guide (wikivoyage)`, url: `https://en.wikivoyage.org/wiki/${encodeURIComponent(page)}`, snippet: "see, do and eat sections" }];
  }
  if (results.length === 0) throw new LlmError("no search results", "empty");
  const result = await llm.generate({
    role: "search",
    model: cfg.GEMINI_MODEL_AGENT,
    system: systemPrompt(input.purpose, input.today),
    contents: [{ role: "user", parts: [{ text: userPrompt(input, results) }] }],
    builtinTools: ["urlContext"],
    jsonSchema: schemaFor(input.purpose),
    temperature: 0.2,
    timeoutMs: 9_000,
    thinking: "minimal",
    trace: input.trace,
  });
  return { result, results };
}

/** The one link worth posting: the result the model credited, else the first page it read; real URLs only. */
async function pickSource(text: string, results: WebResult[], read: LlmSource[], forPosting: boolean): Promise<string | undefined> {
  const credited = results[sourceIndex(text) - 1]?.url;
  const readOk = new Set(read.map((s) => s.uri));
  const candidates = [credited, ...results.map((r) => r.url).filter((u) => readOk.has(u)), ...read.map((s) => s.uri)].filter((u): u is string => Boolean(u));
  for (const c of candidates) {
    const url = isGroundingRedirect(c) ? await resolveRedirect(c, { fetch: currentFetch() }) : c;
    if (url && (forPosting ? linkable(url) : /^https?:\/\//.test(url))) return url;
  }
  return undefined;
}

async function runLookup(llm: Llm, cfg: Config, input: LookupInput): Promise<Lookup> {
  const got = (await grounded(llm, cfg, input)) ?? (await keyless(llm, cfg, input));
  const lookup = parseLookup(input.purpose, got.result.text, input.today);
  if (!lookup) throw new LlmError("the lookup came back unreadable", "empty");
  const source = await pickSource(got.result.text, got.results, got.result.sources ?? [], LIST_PURPOSES.has(input.purpose));
  return source ? { ...lookup, source } : lookup;
}

/** Cached, deduped (concurrent asks share one call) and bounded by SEARCH_TIMEOUT_MS. */
export async function lookup(llm: Llm, cfg: Config, input: LookupInput, timeoutMs = SEARCH_TIMEOUT_MS): Promise<Lookup> {
  const key = cacheKey(input);
  let pending = cache.get(key);
  if (!pending) {
    pending = runLookup(llm, cfg, input);
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmError(`lookup timed out after ${timeoutMs}ms`, "timeout")), timeoutMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- personalization ----------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthOf = (iso: string) => MONTHS[Number(iso.slice(5, 7)) - 1] ?? "";

/** Who the group is and what they want, in short lines for the search prompt. No money, no private data. */
export async function groupContext(ctx: ToolCtx): Promise<string[]> {
  const lines: string[] = [];
  const trip = ctx.trip;
  if (trip.destination_name) lines.push(`trip destination: ${trip.destination_name}`);
  if (trip.start_date && trip.end_date) lines.push(`trip dates: ${trip.start_date} to ${trip.end_date} (${monthOf(trip.start_date)})`);
  const people = ctx.members.length;
  if (people > 1) lines.push(`a group of ${people} friends`);
  const tc = ctx as Partial<TurnCtx>;
  if (typeof tc.view !== "function") return lines;
  try {
    const view = await tc.view();
    if (!trip.start_date && view.dates) lines.push(`likely dates: ${view.dates.start} to ${view.dates.end} (${monthOf(view.dates.start)})`);
    const join = (names: string[]) => names.join(" and ");
    for (const w of view.wants.values()) lines.push(`${join(w.people)} want${w.people.length > 1 ? "" : "s"} ${w.name}`);
    for (const [tag, who] of view.likes) lines.push(`${join(who)} like${who.length > 1 ? "" : "s"} ${tag}`);
    for (const [tag, who] of view.dislikes) lines.push(`${join(who)} ${who.length > 1 ? "don't" : "doesn't"} like ${tag}`);
    for (const [diet, who] of view.dietary) lines.push(`${join(who)}: ${diet}`);
    for (const v of view.vetoes.values()) lines.push(`${join(v.people)} ruled out ${v.name}`);
    for (const l of view.limits) lines.push(`${l.label}: ${l.kind.replace(/_/g, " ")}`);
  } catch (err) {
    log.warn({ err: (err as Error).message.slice(0, 120) }, "group view unavailable for search");
  }
  return lines.slice(0, 12);
}

// ---------- the tool ----------

const webSearch: Tool = {
  decl: {
    name: "web_search",
    description:
      "Look something up on the live web. Use it instead of guessing when someone asks what to do, eat or see somewhere, what's happening there on the trip dates, when something is (a school break like \"unc winter break\", a festival), or another fact you don't know for sure. purpose things_to_do / food / events posts a short numbered list to the chat itself, fitted to the group's preferences and dates; don't repeat it. purpose dates returns {start, end, confidence, note, source} and posts nothing: say the range and where it's from, then call set_trip_dates if the group already agreed to it. purpose facts returns a short answer for you to relay. One call per question; results are cached.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "what to look up, in plain words with the place or school named (e.g. \"things to do in gatlinburg in december\", \"unc chapel hill winter break\")" },
        purpose: { type: "string", enum: [...PURPOSES], description: "things_to_do, food, events (posts a list), dates (returns a date range), facts (returns an answer)" },
      },
      required: ["query", "purpose"],
    },
  },
  soloPost: true,
  async run(args, ctx) {
    const query = str(args.query)?.slice(0, 200);
    if (!query) return { ok: false, error: "query is required" };
    const purpose = (PURPOSES as readonly string[]).includes(String(args.purpose)) ? (args.purpose as Purpose) : "facts";
    const context = await groupContext(ctx);
    let found: Lookup;
    try {
      found = await lookup(ctx.llm, ctx.cfg, { query, purpose, context, today: ctx.today, place: ctx.trip.destination_name ?? undefined, trace: { chatId: ctx.chat.id, turnId: ctx.turnId } });
    } catch (err) {
      const kind = err instanceof LlmError ? err.kind : "api";
      log.warn({ chatId: ctx.chat.id, purpose, err: (err as Error).message.slice(0, 160) }, "web_search failed");
      return { ok: false, error: kind === "timeout" ? "the lookup timed out" : kind === "no_key" ? "web search isn't connected" : "couldn't look that up right now" };
    }
    if (found.kind === "list") {
      const bubble = formatList(found.heading, found.items);
      if (!bubble) return { ok: false, error: "the search didn't turn up enough to list" };
      const posted = say(ctx, bubble);
      if (found.source) {
        ctx.out.push({ type: "link", url: found.source });
        posted.push(found.source);
      }
      return { ok: true, posted, data: { items: found.items.map((i) => stripArtifacts(i.name).toLowerCase()), source: found.source ?? null }, next: "the list is already in the chat; don't repeat it" };
    }
    if (found.kind === "dates") {
      return {
        ok: true,
        data: { start: found.start, end: found.end, confidence: found.confidence, note: found.note, source: found.source ?? null },
        next: found.start
          ? found.confidence === "low"
            ? "this is a guess: say so and ask someone to confirm the dates"
            : "tell the group the range in plain words (e.g. \"unc's winter break is dec 12 – jan 5\") and say it's from the school's calendar; call set_trip_dates only if they already agreed to use it"
          : "couldn't pin the dates down: ask the person for the actual dates",
      };
    }
    return { ok: true, data: { answer: found.answer, source: found.source ?? null }, next: "relay this briefly in your own words" };
  },
};

export const searchFeature: Feature = {
  name: "search",
  tools: [webSearch],
};

export { webSearch };
