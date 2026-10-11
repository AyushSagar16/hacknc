// web_search: look something up online and post it so it reads well in iMessage. The agent picks
// a purpose; a separate, tightly prompted Gemini call does the reading, and code does the
// formatting, so every list looks the same however the model phrased it.
//   things_to_do / food / events → the tool posts a numbered list (and at most one source link,
//                                   which iMessage renders as a rich preview); soloPost.
//   dates                         → structured {start, end, confidence, source} for set_trip_dates.
//   facts                         → a short answer the agent relays in its own words.
// Gemini only: Google Search grounding when the key allows it (a paid tier; free keys get a 429,
// and then it rests six hours), otherwise Gemini answers from what it knows, told to name only
// places it's sure are real. When that fails too, callers fall back (the catalog, a plain reply).
// Results are cached for six hours.
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import type { Config } from "../../config.ts";
import { childLog } from "../../log.ts";
import type { Feature, TurnCtx } from "../feature.ts";
import { LlmError, type GenerateResult, type Llm, type LlmSource } from "../llm.ts";
import { say, str, type Tool, type ToolCtx } from "../tools.ts";
import { cleanAnswer, dietLabel, formatList, MAX_ITEMS, MIN_ITEMS, rangeLabel, stripArtifacts, type ListItem } from "../../search/format.ts";
import { groundItems } from "../../search/verify.ts";
import { saveLookupToTrip } from "./research.ts";
import { excerpt, fetchPage, isGroundingRedirect, keywords, linkable, resolveRedirect, type Fetch, type Page, type WebResult } from "../../search/web.ts";

export const PURPOSES = ["things_to_do", "food", "events", "dates", "facts"] as const;
export type Purpose = (typeof PURPOSES)[number];
const LIST_PURPOSES: ReadonlySet<Purpose> = new Set(["things_to_do", "food", "events"]);

/**
 * The whole lookup's budget, start to posted list. Inside it: the web search (≤4 s), our own page
 * reads in parallel (≤3.5 s), the model read (whatever is left, failing over across models), and
 * a snippets-only fallback on the cheapest model if that read fails.
 */
export const SEARCH_TIMEOUT_MS = 18_000;
/** Characters of page text put in the prompt, in all and per page. */
const PROMPT_PAGE_CHARS = 14_000;
const PAGE_CHARS_MAX = 9_000;
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
  | { kind: "list"; heading: string; items: ListItem[]; source?: string; /** events asked, none dated in the window: these are always-on picks */ noEvents?: boolean }
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
  /** The trip's dates (or the likely ones): events must fall inside them. */
  window?: { start: string; end: string };
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

function systemPrompt(purpose: Purpose, today: string, window?: { start: string; end: string }, fromKnowledge = false): string {
  const base = fromKnowledge
    ? `you help a group of friends planning a trip together. today is ${today}. there are no search results: answer from what you know. only name places, events and facts you are confident are real and still open (well-known, long-running ones), spelled the way they're usually written; if you aren't sure about one, leave it out and return fewer. never invent places, dates or details. ${VOICE}`
    : `you look things up for a group of friends planning a trip together. today is ${today}. only state what the pages or search results below support; never invent places, dates or details. every name you return must be written in the page text or search results, copied as it appears there. ${VOICE}`;
  switch (purpose) {
    case "things_to_do":
    case "food": {
      const what = purpose === "food" ? "places to eat" : "things to do";
      return `${base}
return up to ${MAX_ITEMS} ${what} that best fit this group and their dates, best first. if the sources only name one or two, return just those; never pad the list. each item: "name" is the short name people actually use, 1 to 4 words (e.g. "ober mountain", not "ober mountain adventure park and ski area"); "detail" is one specific, complete phrase of 3 to 8 words (under 55 characters) saying what to do there or why it fits, with a concrete fact when the pages give one (e.g. "skiing and tubing, 10 min up the tramway"); no filler words like "enjoy", "experience", "safely", "everywhere". pick for the group's preferences but don't mention anyone by name. respect dietary needs and anything someone ruled out: if the question asks for a diet (vegetarian, vegan...), only return places the sources say have options for it or whose food plainly suits it (a vegetarian cafe, indian, falafel), never meat-focused ones (bbq, steakhouse), and say in the detail what fits. "heading" restates the ask in a few lowercase words, like "veggie-friendly spots in gatlinburg" or "things to do in gatlinburg in december". "source" is the number of the page or result that helped most (0 if none).`;
    }
    case "events": {
      const span = window ? ` the trip runs ${window.start} to ${window.end}.` : "";
      return `${base}
return up to ${MAX_ITEMS} events or seasonal happenings for the trip dates.${span} an event is something with dates (a festival, a market, a show, holiday lights with a run). for each: "name" (1 to 5 words, as written in the sources), "detail" (3 to 8 words on what it is), "start" and "end" as yyyy-mm-dd when the sources give its dates (leave empty if they don't), and "dated" true only when the sources give dates. you may also add up to 3 always-on highlights with "dated" false. never guess dates. "heading" is a short lowercase title. "source" is the number of the page or result that helped most (0 if none).`;
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
  const source = { type: "integer", description: "number of the page or result used most, 0 if none" };
  if (purpose === "events") {
    const item = { type: "object", properties: { name: { type: "string" }, detail: { type: "string" }, start: { type: "string" }, end: { type: "string" }, dated: { type: "boolean" } }, required: ["name", "detail", "dated"] };
    return { type: "object", properties: { heading: { type: "string" }, items: { type: "array", items: item }, source }, required: ["heading", "items"] };
  }
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
export function searchQueryFor(input: Pick<LookupInput, "query" | "purpose" | "today" | "window">): string {
  const q = input.query.trim();
  if (input.purpose === "dates" && !/\b20\d\d\b/.test(q)) return `${q} ${academicYear(input.today)} academic calendar`;
  if (input.purpose === "events" && input.window && !/\b20\d\d\b/.test(q)) {
    const month = MONTHS[Number(input.window.start.slice(5, 7)) - 1] ?? "";
    return `${q}${month && !q.toLowerCase().includes(month) ? ` ${month}` : ""} ${input.window.start.slice(0, 4)}`;
  }
  return q;
}

function userPrompt(input: LookupInput, results: WebResult[], pages: Page[]): string {
  const lines = [`question: ${input.query}`];
  if (input.context.length) lines.push("", "about the group (fit the answer to them):", ...input.context.map((c) => `- ${c}`));
  if (pages.length) {
    const words = keywords(`${input.query} ${PURPOSE_WORDS[input.purpose]}`);
    lines.push("", "pages (the text we read; only use what is written here or in the search results):");
    // One page (search blocked, only wikivoyage) gets more room than four.
    const room = Math.min(PAGE_CHARS_MAX, Math.floor(PROMPT_PAGE_CHARS / pages.length));
    pages.forEach((p, i) => lines.push(`page ${i + 1}: ${p.url}\n${excerpt(p.text, words, room)}\n`));
  }
  if (results.length) {
    lines.push("", pages.length ? "search results:" : "search results (read the pages at these urls for details):");
    results.forEach((r, i) => lines.push(`${pages.length ? `r${i + 1}` : i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`));
  }
  return lines.join("\n");
}

/** Words that mark the useful part of a long page for each purpose. */
const PURPOSE_WORDS: Record<Purpose, string> = {
  food: "eat restaurant restaurants cafe diner kitchen menu vegetarian vegan brunch dinner lunch breakfast bakery",
  things_to_do: "hike trail park museum tour attraction views visit family",
  events: "festival event events concert market holiday parade show lights season tickets december january",
  dates: "calendar break exam classes begin semester",
  facts: "",
};

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
    const items: ListItem[] = (Array.isArray(j.items) ? j.items : [])
      .map((it) => (it && typeof it === "object" ? (it as Record<string, unknown>) : {}))
      .map((it) => {
        const item: ListItem = { name: str(it.name) ?? "", detail: str(it.detail) };
        if (purpose === "events") {
          const s = str(it.start);
          const e = str(it.end);
          if (it.dated === true && s && ISO.test(s)) {
            item.start = s;
            item.end = e && ISO.test(e) && e >= s ? e : s;
          }
        }
        return item;
      })
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

/** Google Search grounding is tried first; after a quota error (free keys) it rests for six hours. */
let groundingOffUntil = 0;
const groundingEnabled = () => process.env.GEMINI_SEARCH_GROUNDING !== "0" && Date.now() >= groundingOffUntil;
/** Tests: forget a grounding rest. */
export function resetSearchRest(): void {
  groundingOffUntil = 0;
}

interface Got {
  result: GenerateResult;
  results: WebResult[];
  pages: Page[];
  /** Which path answered: Google Search grounding, or Gemini's own knowledge. */
  via: "grounded" | "knowledge";
}

/** Milliseconds left before `deadline`. */
const left = (deadline: number) => deadline - Date.now();

async function grounded(llm: Llm, cfg: Config, input: LookupInput, deadline: number): Promise<Got | null> {
  if (!groundingEnabled()) return null;
  try {
    const result = await llm.generate({
      role: "search",
      model: cfg.GEMINI_MODEL_AGENT,
      system: systemPrompt(input.purpose, input.today, input.window),
      contents: [{ role: "user", parts: [{ text: userPrompt(input, [], []) }] }],
      builtinTools: ["googleSearch"],
      jsonSchema: schemaFor(input.purpose),
      temperature: 0.2,
      timeoutMs: 9_000,
      budgetMs: Math.min(9_000, left(deadline) - 4_000),
      thinking: "minimal",
      trace: input.trace,
    });
    // Grounding chunks are numbered in the order the model saw them, like the keyless results.
    const results = (result.sources ?? []).map((s: LlmSource) => ({ title: s.title ?? "", url: s.uri, snippet: "" }));
    return { result, results, pages: [], via: "grounded" };
  } catch (err) {
    const msg = (err as Error).message;
    if (/\b429\b|RESOURCE_EXHAUSTED|quota|\b400\b|INVALID_ARGUMENT/i.test(msg)) groundingOffUntil = Date.now() + CACHE_TTL_MS;
    log.warn({ err: msg.slice(0, 160) }, "grounded search failed; answering from gemini's own knowledge");
    return null;
  }
}

/** No grounding: Gemini answers from what it knows (no pages to check names against). */
async function fromKnowledge(llm: Llm, cfg: Config, input: LookupInput, deadline: number): Promise<Got> {
  const result = await llm.generate({
    role: "search",
    model: cfg.GEMINI_MODEL_AGENT,
    system: systemPrompt(input.purpose, input.today, input.window, true),
    contents: [{ role: "user", parts: [{ text: userPrompt(input, [], []) }] }],
    jsonSchema: schemaFor(input.purpose),
    temperature: 0.2,
    timeoutMs: 9_000,
    budgetMs: left(deadline) - 300,
    thinking: "minimal",
    trace: input.trace,
  });
  return { result, results: [], pages: [], via: "knowledge" };
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

/** Overlaps the trip window (inclusive). Without a window, any dated event counts. */
const inWindow = (it: ListItem, w?: { start: string; end: string }) => Boolean(it.start) && (!w || (it.start! <= w.end && (it.end ?? it.start!) >= w.start));

async function runLookup(llm: Llm, cfg: Config, input: LookupInput, deadline: number): Promise<Lookup> {
  const t0 = Date.now();
  const got = (await grounded(llm, cfg, input, deadline)) ?? (await fromKnowledge(llm, cfg, input, deadline));
  let lookup = parseLookup(input.purpose, got.result.text, input.today);
  if (!lookup) throw new LlmError("the lookup came back unreadable", "empty");
  // Dates from memory aren't an official calendar.
  if (got.via === "knowledge" && lookup.kind === "dates" && lookup.confidence === "high") lookup = { ...lookup, confidence: "medium" };
  if (lookup.kind !== "list") {
    const source = await pickSource(got.result.text, got.results, got.result.sources ?? [], false);
    log.info({ purpose: input.purpose, via: got.via, ms: Date.now() - t0 }, "lookup done");
    return source ? { ...lookup, source } : lookup;
  }
  // Every posted item must be written in something we actually read: our page texts, else the
  // result titles and snippets. Grounded answers with nothing readable are trusted as grounded.
  const texts: { url: string; text: string }[] = [...got.pages.map((p) => ({ url: p.url, text: p.text })), ...got.results.map((r) => ({ url: r.url, text: `${r.title} ${r.snippet}` }))];
  if (got.via === "grounded" && got.results.length) {
    // Grounding links are redirects: follow them and read the pages so the same check applies.
    const urls = (await Promise.all(got.results.slice(0, PAGES_TO_READ).map((r) => resolveRedirect(r.url, { fetch: currentFetch() })))).filter((u): u is string => Boolean(u));
    const pages = (await Promise.all(urls.map((u) => fetchPage(u, { fetch: currentFetch(), timeoutMs: Math.min(3_000, Math.max(800, left(deadline) - 500)) })))).filter((p): p is Page => p !== null);
    got.pages.push(...pages);
    texts.unshift(...pages.map((p) => ({ url: p.url, text: p.text })));
  }
  // Grounded answers whose pages we couldn't read are trusted as grounded (Google read them);
  // answers from Gemini's own knowledge have nothing to check against.
  const checkable = got.via === "grounded" && got.pages.length > 0;
  const { kept, dropped, bestUrl } = checkable ? groundItems(lookup.items, texts) : { kept: lookup.items, dropped: [], bestUrl: undefined };
  if (dropped.length) log.warn({ purpose: input.purpose, via: got.via, dropped: dropped.map((d) => d.name).slice(0, 5) }, "dropped search items not found in any source");
  let items = kept;
  let fallback = false;
  if (input.purpose === "events") {
    const dated = kept.filter((it) => inWindow(it, input.window));
    if (dated.length >= MIN_ITEMS) items = dated;
    else {
      items = kept.filter((it) => !it.start);
      fallback = true;
    }
  }
  let source = bestUrl && linkable(bestUrl) ? bestUrl : undefined;
  if (!source && !checkable && got.via === "grounded") source = await pickSource(got.result.text, got.results, got.result.sources ?? [], true);
  log.info({ purpose: input.purpose, via: got.via, items: items.length, dropped: dropped.length, ms: Date.now() - t0 }, "lookup done");
  return { kind: "list", heading: headingFor(input, lookup.heading, fallback), items, ...(fallback ? { noEvents: true } : {}), ...(source ? { source } : {}) };
}

/** The place the question is about: the trip's destination, or "in <place>" in the question. */
function placeOf(input: Pick<LookupInput, "place" | "query">): string | null {
  if (input.place) return input.place.split(",")[0]!.trim().toLowerCase();
  const m = /\b(?:in|near|around)\s+([a-z][a-z .'-]{2,30}?)(?=\s+(?:in|for|during|on|this|next|over|around|that|the|from|with|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\s+\d|[?!.,]|$)/i.exec(input.query);
  return m ? m[1]!.trim().toLowerCase() : null;
}

/** A lead-in that says what was asked ("veggie-friendly spots in gatlinburg:"), not a generic title. */
export function headingFor(input: Pick<LookupInput, "query" | "purpose" | "place" | "context" | "window">, modelHeading: string, noEvents = false): string {
  const place = placeOf(input);
  const where = place ? ` in ${place}` : "";
  const when = input.window ? ` ${rangeLabel(input.window.start, input.window.end)}` : "";
  if (input.purpose === "events") return noEvents ? "nothing big that i can find that week — here's what's always good" : `what's on${where}${when}`;
  const h = modelHeading.toLowerCase().replace(/^\W*(?:the\s+)?(?:top|best)\s+/, "");
  if (input.purpose === "food") {
    const diet = dietLabel(input.query);
    if (diet) return `${diet} spots${where}`;
    return h || `places to eat${where}`;
  }
  return h || `things to do${where}`;
}

/** Cached, deduped (concurrent asks share one call) and bounded by SEARCH_TIMEOUT_MS. */
export async function lookup(llm: Llm, cfg: Config, input: LookupInput, timeoutMs = SEARCH_TIMEOUT_MS): Promise<Lookup> {
  const key = cacheKey(input);
  let pending = cache.get(key);
  if (!pending) {
    pending = runLookup(llm, cfg, input, Date.now() + timeoutMs - 250);
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
    const window = await tripWindow(ctx);
    let found: Lookup;
    try {
      found = await lookup(ctx.llm, ctx.cfg, {
        query,
        purpose,
        context,
        today: ctx.today,
        place: ctx.trip.destination_name ?? undefined,
        ...(window ? { window } : {}),
        trace: { chatId: ctx.chat.id, turnId: ctx.turnId },
      });
    } catch (err) {
      const kind = err instanceof LlmError ? err.kind : "api";
      log.warn({ chatId: ctx.chat.id, purpose, kind, err: (err as Error).message.slice(0, 160) }, "web_search failed");
      return { ok: false, error: kind === "no_key" ? NOT_CONNECTED : BUSY };
    }
    // What Atlas finds for a trip also goes on the trip page's research section.
    if (found.kind !== "dates") await saveLookupToTrip(ctx.cfg, ctx.trip, found.kind === "list" ? found.heading : query, found);
    if (found.kind === "list") {
      const items = found.items.map((it) => (it.start ? { ...it, detail: `${rangeLabel(it.start, it.end)}${it.detail ? `: ${it.detail}` : ""}` } : it));
      const bubble = formatList(found.heading, items);
      if (!bubble) {
        const names = found.items.map((i) => stripArtifacts(i.name).toLowerCase()).slice(0, 2);
        return {
          ok: false,
          error: names.length
            ? `only found ${names.length} i could confirm on real pages (${names.join(", ")}). say that honestly in one short line (you can mention ${names.length === 1 ? "it" : "them"}), and offer to look for something more specific. don't add places from memory`
            : "couldn't find anything i could confirm on real pages. say that honestly in one short line and offer to try a more specific search. don't name places from memory",
        };
      }
      const posted = say(ctx, bubble);
      if (found.source) {
        ctx.out.push({ type: "link", url: found.source });
        posted.push(found.source);
      }
      return {
        ok: true,
        posted,
        data: { items: found.items.map((i) => stripArtifacts(i.name).toLowerCase()), source: found.source ?? null, ...(found.noEvents ? { dated_events_found: 0 } : {}) },
        next: "the list is already in the chat; don't repeat it",
      };
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

/** What the agent hears when a lookup fails: enough to write a human reply, no jargon to echo. */
export const BUSY = "couldn't pull that up right now. reply like a friend would, e.g. \"couldn't pull that up right now, try me again in a minute\". don't say timed out, error or search, and don't name places from memory";
const NOT_CONNECTED = "looking things up online isn't set up here. say you can't look that up right now, in plain words";

/** The trip's dates, or the dates the group is converging on. */
async function tripWindow(ctx: ToolCtx): Promise<{ start: string; end: string } | undefined> {
  if (ctx.trip.start_date && ctx.trip.end_date) return { start: ctx.trip.start_date, end: ctx.trip.end_date };
  const tc = ctx as Partial<TurnCtx>;
  if (typeof tc.view !== "function") return undefined;
  try {
    const d = (await tc.view()).dates;
    return d ? { start: d.start, end: d.end } : undefined;
  } catch {
    return undefined;
  }
}

export const searchFeature: Feature = {
  name: "search",
  tools: [webSearch],
};

export { webSearch };
