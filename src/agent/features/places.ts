// Food & activities (the last plan stage): once the stay is booked, Atlas first asks the group what
// kind of food they're into (answers become cuisine facts, kept for later trips in the chat). When
// most of the group has answered (or FOOD_WAIT_MS passes, or what they like is already known), it
// posts ~5 places to eat and ~5 things to do around the stay (SerpApi google_maps,
// src/trips/nearby.ts: a general search plus searches for the group's favourite cuisines and
// interests, merged), honouring dietary needs, cuisines and what people like. "add 2", "add chai pani", a 👍 on someone's "let's do chai pani", or the
// pick_place tool puts a place on the itinerary (the trip page shows it); "we're good" settles the
// stage. Prices show as words ("mid-range"), never "$$", so nothing here is a dollar figure.
import { addDays, daysBetween, now } from "../../clock.ts";
import { childLog } from "../../log.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, labelOf, messageByProviderId, type MessageRow } from "../../db/repos/core.ts";
import { enqueueJob, rescheduleSingleton } from "../../pipeline/jobs.ts";
import { recordAsk } from "../../profile/store.ts";
import { groupView, interestWeights, type GroupView } from "../../profile/groupView.ts";
import { profilesFor } from "../../profile/store.ts";
import { itineraryInput } from "../../site/content.ts";
import { requestSync } from "../../site/publish.ts";
import { dayLabel } from "../../trips/itinerary.ts";
import { activityTags, placeFacts, searchNearby, settingOf, SHORTLIST_SIZE, type NearbyKind, type NearbyPlace, type Origin } from "../../trips/nearby.ts";
import { tripDestination } from "../../trips/place.ts";
import { markPicked, placesFor, saveShortlist, type TripPlaceRow } from "../../trips/placesStore.ts";
import { getStages, setStage } from "../../trips/stages.ts";
import { tripById, updateTrip, type ItineraryDay, type TripRow } from "../../trips/state.ts";
import type { AppServices, Feature, TurnCtx } from "../feature.ts";
import { ToolError, say, str, strList, type Tool } from "../tools.ts";
import { nameList } from "./planning.ts";
import { pricingDeps } from "./proposals.ts";
import { requestItinerary } from "./site.ts";

const log = childLog({ component: "places" });
export const SUGGEST_JOB = "places.suggest";
/** How long the food question waits for answers before the shortlist goes out anyway. */
export const FOOD_WAIT_MS = 10 * 60_000;
const suggestKey = (tripId: number) => `places:suggest:${tripId}`;
/** The asks row that marks "asked about food for this trip" (asks are per person and chat). */
export const foodAskField = (tripId: number) => `food:${tripId}`;
const first = (label: string) => label.toLowerCase().split(/\s+/)[0] ?? label.toLowerCase();
const MAX_ITEMS_PER_DAY = 8;

// ---------- where from, and what the group wants ----------

/** Distances are from the booked stay; before one is booked, from the middle of the destination. */
export function originFor(trip: Pick<TripRow, "stay" | "destination_id" | "destination_place" | "destination_name">): Origin | undefined {
  const stay = trip.stay;
  if (stay && typeof stay.lat === "number" && typeof stay.lon === "number") return { lat: stay.lat, lon: stay.lon, label: stay.name.toLowerCase() };
  const dest = tripDestination(trip);
  if (!dest) return undefined;
  return { lat: dest.lat, lon: dest.lon, label: `downtown ${dest.name.toLowerCase()}` };
}

export interface GroupPrefs {
  dietary: Map<string, string[]>;
  interests: Record<string, number>;
  /** Cuisine → + per person who wants it, − per person who doesn't. */
  cuisines: Record<string, number>;
  lowMobility: boolean;
}

export function cuisineWeights(view: Pick<GroupView, "cuisines" | "cuisineDislikes">): Record<string, number> {
  const w: Record<string, number> = {};
  for (const [c, who] of view.cuisines ?? []) w[c] = (w[c] ?? 0) + who.length;
  for (const [c, who] of view.cuisineDislikes ?? []) w[c] = (w[c] ?? 0) - who.length;
  return w;
}

export function prefsOf(view: GroupView): GroupPrefs {
  return {
    dietary: new Map([...view.dietary].map(([need, people]) => [need, people.map(first)])),
    interests: interestWeights(view),
    cuisines: cuisineWeights(view),
    lowMobility: view.limits.some((l) => l.kind === "low_mobility"),
  };
}

/** People who've said what they like to eat (a cuisine either way, or "anything"). */
export function foodAnswered(view: GroupView): Set<number> {
  return new Set(view.members.filter((m) => (m.profile.cuisines?.length ?? 0) + (m.profile.cuisineDislikes?.length ?? 0) > 0).map((m) => m.personId));
}

/** Enough of the group has said what they eat to search for it: a majority (everyone, with two). */
export function foodKnown(view: GroupView): boolean {
  const n = view.members.length;
  return n > 0 && foodAnswered(view).size * 2 > n;
}

/** "maya: indian, thai · leo: bbq" from what each person likes to eat. */
export function cuisineSummary(view: GroupView): string {
  return view.members
    .map((m) => ({ name: first(m.label), likes: (m.profile.cuisines ?? []).map((c) => c.value).filter((c) => c !== "anything") }))
    .filter((x) => x.likes.length)
    .map((x) => `${x.name}: ${x.likes.slice(0, 3).join(", ")}`)
    .join(" · ");
}

export const FOOD_QUESTION = "what kind of food is everyone into for this trip? cuisines, a spot you've heard of, anything you're craving";

/** The food question, once per trip, after the stay is booked. */
export function foodAskText(stayName: string | undefined, waitingOn: string[]): string {
  const lead = stayName ? `🍽️ ${stayName.toLowerCase()} is locked in, so now food and things to do.` : "🍽️ now food and things to do.";
  return `${lead}\n${waitingOn.length && waitingOn.length <= 3 ? `${nameList(waitingOn)}, ` : ""}${FOOD_QUESTION}?`;
}

/** Whether the food question went out for this trip, and who it went to. */
export async function foodAsked(chatId: number, tripId: number): Promise<{ at: Date | null; people: number[] }> {
  const rows = await q<{ person_id: number; asked_at: Date }>(`SELECT person_id, asked_at FROM asks WHERE chat_id = $1 AND field = $2`, [chatId, foodAskField(tripId)]);
  return { at: rows.length ? rows.map((r) => r.asked_at).reduce((a, b) => (a < b ? a : b)) : null, people: rows.map((r) => Number(r.person_id)) };
}

async function viewForTrip(trip: TripRow): Promise<GroupView> {
  const members = await activeMembers(trip.chat_id);
  const profiles = await profilesFor(members.map((m) => m.id), { chatId: trip.chat_id, tripId: trip.id });
  return groupView(
    members.map((m) => ({ personId: m.id, label: labelOf(m), profile: profiles.get(m.id)! })),
    trip.start_date ?? now().toISOString().slice(0, 10),
  );
}

// ---------- the shortlist ----------

const NEED_WORDS: Record<string, string> = {
  vegetarian: "vegetarian",
  vegan: "vegan",
  halal: "halal",
  kosher: "kosher",
  gluten_free: "gluten-free",
  dairy_free: "dairy-free",
  nut_allergy: "nut-free",
  pescatarian: "pescatarian",
};

/** "(vegetarian-friendly for maya, gluten-free for leo)". */
export function dietNote(dietary: Map<string, string[]>): string {
  const parts = [...dietary].filter(([need]) => NEED_WORDS[need]).map(([need, people]) => `${NEED_WORDS[need]}${need === "vegetarian" || need === "vegan" ? "-friendly" : ""} for ${nameList(people)}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** One line of a shortlist: "2. Chai Pani: indian restaurant, 4.7★, mid-range, 3 min walk". */
export function shortlistLine(idx: number, p: Pick<NearbyPlace, "name" | "category" | "rating" | "priceLevel" | "distanceM">): string {
  const facts = placeFacts(p, true);
  return `${idx}. ${p.name}${facts ? `: ${facts}` : ""}`;
}

export function shortlistText(kind: NearbyKind, places: { idx: number; place: NearbyPlace }[], origin: Origin, prefs: GroupPrefs): string {
  const head = kind === "food" ? `🍽️ places to eat near ${origin.label}${dietNote(prefs.dietary)}` : `🎟️ things to do near ${origin.label}`;
  return [head, ...places.map((x) => shortlistLine(x.idx, x.place))].join("\n");
}

export const PICK_HOWTO = `say "add 2" (or the name) and i'll put it on the plan`;

export interface Shortlist {
  texts: string[];
  rows: TripPlaceRow[];
  sources: string[];
}

/** Search, rank, save and word the shortlists. Throws a ToolError when there's nowhere to search around. */
export async function buildShortlist(trip: TripRow, view: GroupView, kinds: NearbyKind[], opts: { query?: string; at: Date }): Promise<Shortlist> {
  const origin = originFor(trip);
  if (!origin) throw new ToolError("no destination is locked yet; settle where first");
  const prefs = prefsOf(view);
  const existing = await placesFor(trip.id);
  const picked = new Set(existing.filter((r) => r.status === "picked").flatMap((r) => [r.source_id, r.name.toLowerCase()]));
  const dest = tripDestination(trip);
  const texts: string[] = [];
  const rows: TripPlaceRow[] = [];
  const sources: string[] = [];
  for (const kind of kinds) {
    const result = await searchNearby(
      kind,
      origin,
      { dest, query: kinds.length === 1 ? opts.query : undefined, dietary: [...prefs.dietary.keys()], interests: prefs.interests, cuisines: prefs.cuisines, lowMobility: prefs.lowMobility, exclude: picked, limit: SHORTLIST_SIZE },
      pricingDeps(),
    );
    sources.push(`${kind}:${result.source}`);
    if (!result.places.length) continue;
    // Food is numbered 1–5 and activities 6–10, so one number always means one place.
    const start = kind === "food" ? 1 : SHORTLIST_SIZE + 1;
    const saved = await saveShortlist(trip.id, kind, result.places, start, opts.at);
    rows.push(...saved);
    texts.push(shortlistText(kind, result.places.map((place, i) => ({ idx: start + i, place })), origin, prefs));
  }
  // What the trip's research found on during the dates, so nothing good gets missed.
  if (kinds.includes("activity") && texts.length && !opts.query) {
    const events = await eventsDuringTrip(trip.id);
    if (events.length) texts[texts.length - 1] += `\n📅 also on during your dates: ${events.join(", ")}`;
  }
  if (texts.length) texts[texts.length - 1] += `\n${PICK_HOWTO}`;
  return { texts, rows, sources };
}

/** "Top picks: a, b, c." from the background research on events during the trip (none if it found none). */
export async function eventsDuringTrip(tripId: number): Promise<string[]> {
  const row = (await q<{ summary: string }>(`SELECT summary FROM trip_research WHERE trip_id = $1 AND lower(topic) LIKE 'events%' ORDER BY created_at DESC LIMIT 1`, [tripId]))[0];
  const m = row ? /^Top picks:\s*(.+?)\.?$/i.exec(row.summary.trim()) : null;
  return m ? m[1]!.split(/,\s*/).map((x) => x.trim().replace(/\$/g, "")).filter((x) => x.length > 1 && x.length <= 60).slice(0, 3) : [];
}

// ---------- putting a pick on the itinerary ----------

const isFoodItem = (i: ItineraryDay["items"][number]) => i.activityId.startsWith("place:food:") || i.time === "dinner" || i.time === "lunch";
const MORNING = /\b(morning|am|breakfast|brunch)\b/i;

export interface Placement {
  itinerary: ItineraryDay[];
  date: string;
  time: string;
}

/**
 * Put a picked place on the plan. Food goes to the day with the fewest meals planned (dinner, then
 * lunch); things to do go to the least busy day, middle days before arrival and departure days
 * (morning, then afternoon). Returns null when every day is full.
 */
export function placeOnItinerary(
  current: ItineraryDay[],
  trip: { start: string; end: string },
  item: { kind: NearbyKind; activityId: string; name: string; setting: "outdoor" | "indoor" | "either"; costCents?: number; tags?: string[]; notes?: string },
): Placement | null {
  const span = daysBetween(trip.start, trip.end);
  if (!Number.isFinite(span) || span < 0) return null;
  const byDate = new Map(current.map((d) => [d.date, d]));
  const days = Array.from({ length: span + 1 }, (_, i) => addDays(trip.start, i)).map((date) => byDate.get(date) ?? { date, items: [] });
  const open = days.map((d, i) => ({ d, i })).filter(({ d }) => d.items.length < MAX_ITEMS_PER_DAY);
  if (!open.length) return null;
  const edge = (i: number) => days.length > 2 && (i === 0 || i === days.length - 1);
  const load = (d: ItineraryDay) => (item.kind === "food" ? d.items.filter(isFoodItem).length : d.items.filter((x) => !isFoodItem(x)).length);
  const best = open.sort((a, b) => load(a.d) - load(b.d) || (item.kind === "activity" ? Number(edge(a.i)) - Number(edge(b.i)) : 0) || a.i - b.i)[0]!;
  const day = best.d;
  const time =
    item.kind === "food"
      ? day.items.some((x) => x.time === "dinner") ? "lunch" : "dinner"
      : day.items.some((x) => !isFoodItem(x) && x.time && MORNING.test(x.time)) ? "afternoon" : "morning";
  const added = {
    activityId: item.activityId,
    name: item.name,
    setting: item.setting,
    costCents: item.costCents ?? 0,
    ...(item.tags?.length ? { tags: item.tags } : {}),
    time,
    ...(item.notes ? { notes: item.notes } : {}),
  };
  const next = days.map((d) => (d.date === day.date ? { ...d, items: [...d.items, added] } : d));
  return { itinerary: next, date: day.date, time };
}

/** The itinerary item for a picked row, validated like Atlas's own plan (length, no prices). */
export function itemFor(row: TripPlaceRow, dest: ReturnType<typeof tripDestination>) {
  const catalog = row.source === "catalog" ? dest?.activities.find((a) => `catalog:${a.id}` === row.source_id) : undefined;
  const place: NearbyPlace = {
    kind: row.kind,
    sourceId: row.source_id,
    source: row.source,
    name: row.name,
    types: row.category ? [row.category] : [],
    ...(row.category ? { category: row.category } : {}),
    ...(catalog ? { setting: catalog.setting, tags: [...catalog.tags] } : {}),
  };
  const facts = placeFacts({ rating: row.rating ?? undefined, priceLevel: row.price_level ?? undefined, distanceM: row.distance_m ?? undefined, category: row.category ?? undefined }, true);
  const name = row.name.slice(0, 80);
  const notes = facts ? facts.slice(0, 200) : undefined;
  const parsed = itineraryInput.safeParse({ days: [{ date: "2000-01-01", items: [{ name, setting: settingOf(place), ...(notes ? { notes } : {}) }] }] });
  const ok = parsed.success;
  return {
    kind: row.kind,
    activityId: catalog ? catalog.id : `place:${row.kind}:${row.source_id}`,
    name: ok ? name : name.replace(/[$€£]/g, ""),
    setting: settingOf(place),
    costCents: catalog?.costCents ?? 0,
    tags: catalog ? [...catalog.tags] : row.kind === "activity" ? activityTags(place) : ["food"],
    ...(ok && notes ? { notes } : {}),
  };
}

// ---------- picking ----------

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A number or a name, against this trip's places. undefined when it doesn't name exactly one. */
export function resolvePlace(ref: string, rows: TripPlaceRow[]): TripPlaceRow | undefined {
  const r = ref.trim().replace(/^#/, "");
  if (/^\d{1,2}$/.test(r)) return rows.find((x) => x.idx === Number(r));
  const n = norm(r);
  if (n.length < 3) return undefined;
  const exact = rows.filter((x) => norm(x.name) === n);
  if (exact.length === 1) return exact[0];
  const partial = rows.filter((x) => {
    const name = norm(x.name);
    return name.includes(n) || (n.includes(name) && name.length >= 4);
  });
  return partial.length === 1 ? partial[0] : undefined;
}

/** Places named anywhere in a sentence ("chai pani sounds amazing"). */
export function placesNamedIn(textIn: string, rows: TripPlaceRow[]): TripPlaceRow[] {
  const t = ` ${norm(textIn)} `;
  return rows.filter((x) => {
    const name = norm(x.name);
    if (name.length < 4) return false;
    if (t.includes(` ${name} `)) return true;
    // "chai pani" for "Chai Pani", "tupelo honey" for "Tupelo Honey Southern Kitchen & Bar".
    const words = name.split(" ");
    return words.length > 2 && t.includes(` ${words.slice(0, 2).join(" ")} `);
  });
}

/** Split "2 and 7", "2, 7", "chai pani and biltmore" into refs. */
export function splitRefs(s: string): string[] {
  return s
    .split(/\s*(?:,|\band\b|&|\+|\/)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

export interface PickOutcome {
  added: { row: TripPlaceRow; date: string | null; time: string | null }[];
  already: TripPlaceRow[];
  unknown: string[];
}

/** Pick places for a trip (by number or name): mark them picked and put them on the itinerary. */
export async function pickPlaces(trip: TripRow, refs: string[], by: number | null, at: Date): Promise<{ outcome: PickOutcome; trip: TripRow }> {
  const rows = await placesFor(trip.id);
  const outcome: PickOutcome = { added: [], already: [], unknown: [] };
  let itinerary = trip.itinerary;
  const dest = tripDestination(trip);
  const done = new Set<number>();
  for (const ref of refs) {
    const row = resolvePlace(ref, rows);
    if (!row) {
      outcome.unknown.push(ref);
      continue;
    }
    if (done.has(row.id)) continue;
    done.add(row.id);
    if (row.status === "picked") {
      outcome.already.push(row);
      continue;
    }
    let placed: Placement | null = null;
    if (trip.start_date && trip.end_date) placed = placeOnItinerary(itinerary, { start: trip.start_date, end: trip.end_date }, itemFor(row, dest));
    if (placed) itinerary = placed.itinerary;
    await markPicked(row.id, by, placed?.date ?? null, at);
    outcome.added.push({ row, date: placed?.date ?? null, time: placed?.time ?? null });
  }
  if (itinerary !== trip.itinerary) trip = await updateTrip(trip.id, { itinerary });
  if (outcome.added.length) await setStage(trip.id, "food_activities", "in_progress");
  return { outcome, trip };
}

/** "✓ added chai pani (fri 11/13, dinner) and biltmore estate (sat 11/14, morning) to the plan". */
export function pickText(o: PickOutcome): string {
  const lines: string[] = [];
  const placed = o.added.filter((a) => a.date);
  const unplaced = o.added.filter((a) => !a.date);
  if (placed.length) lines.push(`✓ added ${nameList(placed.map((a) => `${a.row.name.toLowerCase()} (${dayLabel(a.date!)}, ${a.time})`))} to the plan`);
  if (unplaced.length) lines.push(`✓ saved ${nameList(unplaced.map((a) => a.row.name.toLowerCase()))}; it goes on the plan once the dates are set`);
  if (o.already.length) lines.push(`${nameList(o.already.map((r) => r.name.toLowerCase()))} ${o.already.length === 1 ? "is" : "are"} already on it`);
  return lines.join("\n");
}

async function pickAndSay(tc: TurnCtx, refs: string[], by: number | null): Promise<PickOutcome> {
  await tc.nonCancellable();
  const { outcome, trip } = await pickPlaces(tc.trip, refs, by, tc.now);
  tc.trip = trip;
  const text = pickText(outcome);
  if (text) say(tc, text);
  if (outcome.added.length) await requestSync(tc.cfg, tc.trip).catch(() => undefined);
  return outcome;
}

/** The stage is done: settle it and link the itinerary. */
async function finish(tc: TurnCtx): Promise<number> {
  const rows = (await placesFor(tc.trip.id)).filter((r) => r.status === "picked");
  await tc.nonCancellable();
  await setStage(tc.trip.id, "food_activities", "decided");
  const placed = rows.filter((r) => r.day).length;
  say(tc, `food & activities are set ✓ ${rows.length} ${rows.length === 1 ? "place" : "places"} on the plan${placed < rows.length ? ` (${rows.length - placed} waiting on dates)` : ""}`);
  // The rest of the day-by-day plan is Atlas's to write now, around the picks (a follow-up turn).
  if (tc.trip.start_date) await requestItinerary(tc.trip, "picked");
  return rows.length;
}

// ---------- tools ----------

const suggestPlacesTool: Tool = {
  soloPost: true,
  decl: {
    name: "suggest_places",
    description:
      "Find places to eat and things to do near where the group is staying (or the middle of the destination before a stay is booked) and post a numbered shortlist (~5 of each) with rating, price level and walk/drive time. Honours everyone's dietary needs and what they like. Use when the stay is booked, when food & activities are next, or when someone asks for food or things to do there. Pass looking_for for a specific ask (\"tacos\", \"breweries\", \"hikes\") with just that kind.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["food", "activities", "both"], description: "default both" },
        looking_for: { type: "string", description: "only for a specific ask, e.g. \"sushi\", \"live music\"" },
      },
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const kinds: NearbyKind[] = args.kind === "food" ? ["food"] : args.kind === "activities" ? ["activity"] : ["food", "activity"];
    await tc.nonCancellable();
    const list = await buildShortlist(tc.trip, await tc.view(), kinds, { query: str(args.looking_for), at: tc.now });
    if (!list.texts.length) throw new ToolError("couldn't look up places there right now; say so in a few words and offer to try again later");
    say(tc, ...list.texts);
    await setStage(tc.trip.id, "food_activities", "in_progress");
    return { ok: true, data: { shortlist: list.rows.map((r) => `${r.idx}. ${r.name}`) }, next: "the shortlist was posted; reply NO_REPLY" };
  },
};

const pickPlaceTool: Tool = {
  decl: {
    name: "pick_place",
    description:
      "Someone wants places from the shortlist on the plan (\"add 2\", \"let's do chai pani\", \"put the biltmore on saturday\"). Pass their numbers or names. Saves them, puts each on a day of the itinerary and the trip page, and posts one confirmation line.",
    parameters: {
      type: "object",
      properties: {
        places: { type: "array", items: { type: "string" }, description: "shortlist numbers or names" },
        member: { type: "string", description: "who picked them (first name, or \"me\" for the sender)" },
      },
      required: ["places"],
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const refs = strList(args.places).flatMap(splitRefs);
    if (!refs.length) throw new ToolError("say which places (numbers or names)");
    if (!(await placesFor(tc.trip.id)).length) throw new ToolError("there's no shortlist yet; call suggest_places first");
    const by = tc.resolve(str(args.member) ?? "me") ?? tc.senderId;
    const o = await pickAndSay(tc, refs, by);
    if (!o.added.length && !o.already.length) throw new ToolError(`couldn't match ${nameList(o.unknown.map((u) => `"${u}"`))} to the shortlist; ask which one they mean`);
    return {
      ok: true,
      data: { added: o.added.map((a) => a.row.name), unknown: o.unknown },
      next: o.unknown.length ? `posted; also ask which place they meant by ${nameList(o.unknown)}` : "the confirmation was posted; reply NO_REPLY",
    };
  },
};

const finishPlacesTool: Tool = {
  soloPost: true,
  decl: {
    name: "finish_places",
    description: "The group is happy with the food and things to do they've picked (\"we're good\", \"that's plenty\"). Marks food & activities settled and links the itinerary.",
    parameters: { type: "object", properties: {} },
  },
  async run(_args, ctx) {
    const tc = ctx as TurnCtx;
    const n = await finish(tc);
    return { ok: true, data: { picked: n }, next: "posted; reply NO_REPLY" };
  },
};

// ---------- fast paths ----------

const ADD = /^\W*(?:(?:ok(?:ay)?|yes|yeah|yea|ooh|oh|and|also),?\s+)*(?:(?:atlas|@atlas),?\s+)?(?:(?:can you |pls |please )?(?:add|put)|let'?s (?:do|add|go to|hit)|we want|i want)\s+(.+?)(?:\s+(?:to|on|in)\s+(?:the\s+)?(?:plan|itinerary|list|trip))?\s*(?:pls|please)?\W*$/i;
const DONE = /^\W*(?:(?:ok(?:ay)?|cool|nice|great|perfect|yeah|yep),?\s+)*(?:i think\s+)?(?:we'?re|were|that'?s|thats|i'?m|im)\s+(?:all\s+)?(?:good|set|done|it|enough|plenty)(?:\s+(?:for (?:now|food|places|activities)|then|thanks|thx|ty))*\W*$/i;

async function lastAtlasText(chatId: number): Promise<string> {
  return (await one<{ text: string }>(`SELECT text FROM messages WHERE chat_id = $1 AND direction = 'outbound' ORDER BY id DESC LIMIT 1`, [chatId]))?.text ?? "";
}

async function addFastPath(msg: MessageRow, tc: TurnCtx): Promise<boolean> {
  if (msg.kind !== "text" || msg.person_id === null || !msg.speakable) return false;
  const m = ADD.exec(msg.text);
  if (!m) return false;
  const rows = await placesFor(tc.trip.id);
  if (!rows.length) return false;
  const refs = splitRefs(m[1]!);
  // Every part has to name one place; otherwise it's not for us ("add 20 for gas").
  if (!refs.length || refs.some((r) => !resolvePlace(r, rows))) return false;
  tc.senderId = msg.person_id;
  await pickAndSay(tc, refs, msg.person_id);
  return true;
}

/** 👍/❤️ on someone's "let's do chai pani" picks it (when it names exactly one shortlisted place). */
async function reactionFastPath(msg: MessageRow, tc: TurnCtx): Promise<boolean> {
  if (msg.kind !== "reaction" || msg.person_id === null || msg.meta?.removed === true) return false;
  const tapback = msg.meta?.tapback as string | null;
  if (tapback !== "like" && tapback !== "love") return false;
  const rows = (await placesFor(tc.trip.id)).filter((r) => r.status === "suggested");
  if (!rows.length) return false;
  const target = await messageByProviderId(tc.chat.id, String(msg.meta?.targetId ?? ""));
  if (!target || target.direction !== "inbound") return false;
  const named = placesNamedIn(target.text, rows);
  if (named.length !== 1) return false;
  tc.senderId = msg.person_id;
  await pickAndSay(tc, [String(named[0]!.idx ?? named[0]!.name)], msg.person_id);
  return true;
}

async function doneFastPath(msg: MessageRow, tc: TurnCtx): Promise<boolean> {
  if (msg.kind !== "text" || msg.person_id === null || !msg.speakable || !DONE.test(msg.text)) return false;
  const stages = await getStages(tc.trip.id);
  if (stages.food_activities !== "in_progress") return false;
  if (!(await placesFor(tc.trip.id)).some((r) => r.status === "picked")) return false;
  // Only right after Atlas's shortlist or a pick confirmation, so "we're good" about anything else isn't taken.
  const last = await lastAtlasText(tc.chat.id);
  if (!/^(?:✓ added|✓ saved|🍽️|🎟️)/u.test(last) && !/already on it$|i'll put it on the plan$/.test(last)) return false;
  tc.senderId = msg.person_id;
  await finish(tc);
  return true;
}

// ---------- the feature ----------

function stayBooked(trip: TripRow): boolean {
  return Boolean(trip.stay && trip.stay.name);
}

export const placesFeature: Feature = {
  name: "places",
  tools: [suggestPlacesTool, pickPlaceTool, finishPlacesTool],

  async fastPath(msg, tc) {
    return (await reactionFastPath(msg, tc)) || (await addFastPath(msg, tc)) || (await doneFastPath(msg, tc));
  },

  async situation(tc) {
    const origin = originFor(tc.trip);
    if (!origin) return null;
    const stages = await getStages(tc.trip.id);
    if (stages.location !== "decided") return null;
    const rows = await placesFor(tc.trip.id);
    const lines: string[] = [];
    const suggested = rows.filter((r) => r.status === "suggested" && r.idx !== null);
    const picked = rows.filter((r) => r.status === "picked");
    if (suggested.length) lines.push(`shortlist (posted): ${suggested.map((r) => `${r.idx}. ${r.name} (${r.kind})`).join("; ")}`);
    if (picked.length) lines.push(`picked: ${picked.map((r) => `${r.name}${r.day ? ` on ${dayLabel(r.day)}` : ""}${r.picked_by ? ` (${tc.label(r.picked_by)})` : ""}`).join("; ")}`);
    if (!rows.length && stayBooked(tc.trip)) {
      const view = await tc.view();
      const asked = await foodAsked(tc.chat.id, tc.trip.id);
      const answered = foodAnswered(view);
      const likes = cuisineSummary(view);
      if (asked.at) {
        const waiting = view.members.filter((m) => !answered.has(m.personId)).map((m) => first(m.label));
        lines.push(
          `you asked the group what food they're into${likes ? `; so far: ${likes}` : ""}${waiting.length ? `. still waiting on ${nameList(waiting)}` : ""}.`,
          foodKnown(view)
            ? "most of the group has answered: the shortlist posts on its own in a moment, reply NO_REPLY unless someone asked something"
            : "when someone answers it, reply NO_REPLY (a 👍 goes on their message automatically) unless they asked something; don't re-ask anyone. the shortlist posts on its own once most have answered. if they say to just pick or want to see places now, call suggest_places",
        );
      } else lines.push(`nothing suggested yet near ${origin.label}. the food question posts on its own; suggest_places if someone asks for places now${likes ? ` (food they like: ${likes})` : ""}`);
    } else if (!rows.length) lines.push("suggest_places finds places to eat and things to do there whenever someone asks");
    lines.push(`stage: food & activities ${stages.food_activities.replace("_", " ")}. picks: pick_place. when the group's happy with what's picked: finish_places`);
    return { title: "food & things to do", lines };
  },

  async afterTurn(tc) {
    // Right after the stay is booked: the food question follows on its own, once; the shortlist
    // follows once most of the group has answered it.
    if (!tc.chat.is_group || !stayBooked(tc.trip)) return;
    const stages = await getStages(tc.trip.id);
    if (stages.stay !== "decided" || stages.food_activities === "decided") return;
    if ((await placesFor(tc.trip.id)).length) return;
    const asked = await foodAsked(tc.chat.id, tc.trip.id);
    if (!asked.at) {
      if (stages.food_activities !== "open") return;
      await enqueueJob(SUGGEST_JOB, { tripId: tc.trip.id }, { dueAt: new Date(now().getTime() + 5_000), singletonKey: suggestKey(tc.trip.id) });
      return;
    }
    if (foodKnown(await tc.view())) await rescheduleSingleton(suggestKey(tc.trip.id), new Date(now().getTime() + 3_000));
  },

  jobs(svc) {
    return {
      // The same job runs twice (the question, then the list): each run needs its own outbox ids.
      [SUGGEST_JOB]: async (payload, { jobId }) => suggestFromJob(svc, Number(payload.tripId), `places${jobId}${payload.asked ? ":list" : ""}`),
    };
  },
};

/**
 * After the stay is booked, from a background job. First run: ask what food the group is into
 * (or, when most of them have said before, go straight to the shortlist), then check back in
 * FOOD_WAIT_MS. Later runs (most have answered, or the wait is over): post the shortlist.
 */
export async function suggestFromJob(svc: Pick<AppServices, "post">, tripId: number, guid: string): Promise<void | { rescheduleAt: Date; payload: Record<string, unknown> }> {
  const trip = await tripById(tripId);
  if (!trip || !stayBooked(trip)) return;
  const focused = await one<{ focus_trip_id: number | null }>(`SELECT focus_trip_id FROM chats WHERE id = $1`, [trip.chat_id]);
  if (focused?.focus_trip_id !== trip.id) return;
  const stages = await getStages(trip.id);
  if (stages.food_activities === "decided" || (await placesFor(trip.id)).length) return;
  const view = await viewForTrip(trip);
  const asked = await foodAsked(trip.chat_id, trip.id);
  if (!asked.at && !foodKnown(view)) {
    if (stages.food_activities !== "open") return;
    const at = now();
    const answered = foodAnswered(view);
    const waiting = view.members.filter((m) => !answered.has(m.personId));
    for (const m of view.members) await recordAsk(m.personId, trip.chat_id, foodAskField(trip.id), at);
    await setStage(trip.id, "food_activities", "in_progress");
    await svc.post(trip.chat_id, guid, [{ type: "say", text: foodAskText(trip.stay?.name, answered.size ? waiting.map((m) => first(m.label)) : []) }]);
    return { rescheduleAt: new Date(at.getTime() + FOOD_WAIT_MS), payload: { tripId: trip.id, asked: true } };
  }
  let list: Shortlist;
  try {
    list = await buildShortlist(trip, view, ["food", "activity"], { at: now() });
  } catch (err) {
    log.warn({ err: (err as Error).message, tripId }, "no shortlist after the stay was booked");
    return;
  }
  if (!list.texts.length) return;
  // Known from before the question (an earlier trip in this chat): say what it's going off.
  const likes = cuisineSummary(view);
  if (!asked.at && likes) list.texts[0] = `going off what you've said you like to eat (${likes})\n${list.texts[0]}`;
  await setStage(trip.id, "food_activities", "in_progress");
  await svc.post(trip.chat_id, guid, list.texts.map((text) => ({ type: "say" as const, text })));
}
