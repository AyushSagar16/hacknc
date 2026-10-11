// Destination proposals and decisions. Hard constraints filter the catalog, soft preferences
// score it, the top candidates get live prices (SerpApi Google Flights/Hotels, cached) with
// labeled estimates as fallback, and three options go out with per-person cost breakdowns and
// a poll. Votes arrive as native poll votes, tapbacks on an option bubble, or plain text ("2",
// "lisbon"); a majority of the group (or everyone voting) decides and locks the trip in.
import { config } from "../../config.ts";
import { now } from "../../clock.ts";
import { formatUsd } from "../../money/cents.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, ensureMember, insertMessage, labelOf, upsertPerson, type MessageRow } from "../../db/repos/core.ts";
import { enqueueJob, rescheduleSingleton } from "../../pipeline/jobs.ts";
import { budgetRows } from "../../nessie/budgets.ts";
import { destinationById, destinations, findDestination, resolveHome, type Destination, type Tag } from "../../trips/catalog.ts";
import { applyGroupAsk, buildConstraints, type GroupAsk } from "../../trips/constraints.ts";
import { hardFilter, hasTag, tripMonths, type Rejection } from "../../trips/filter.ts";
import { estimateCost, travelPlan, type CostBreakdown } from "../../trips/estimate.ts";
import { googleFlightsLink, googleHotelsLink } from "../../trips/links.ts";
import { closedPollFor, closePoll, createPoll, pollById, lastDecidedPoll, openNativePolls, openPolls, recordVote, setVote, voteRows, votesFor, type PollRow } from "../../trips/pollStore.ts";
import { priceOption, type PriceCache, type PriceDeps } from "../../trips/pricing.ts";
import { applyVibe, bestReason, inferVibe, pickThree, scoreDestinations, vibeTags, type Scored } from "../../trips/score.ts";
import { focusTrip, updateTrip, type TripPlace } from "../../trips/state.ts";
import { geocodePlace, GeocodeUnavailable, placeLabel, type GeocodeCache } from "../../trips/geocode.ts";
import { placeAsDestination, placeOf, tripDestination } from "../../trips/place.ts";
import { getStages, reopenStage, setStage } from "../../trips/stages.ts";
import { resetTravelPlans } from "../../trips/travel.ts";
import { parseVote, reconcileVotes, tally, type ProviderVote } from "../../trips/votes.ts";
import { formatRange } from "./planning.ts";
import { fireTripLocked, type AppServices, type Feature, type TurnCtx } from "../feature.ts";
import type { Figure } from "../figures.ts";
import { ToolError, num, say, str, strList, type Tool } from "../tools.ts";

const priceCache: PriceCache = {
  async get(key) {
    const row = await one<{ body: unknown; fetched_at: Date }>(`SELECT body, fetched_at FROM price_cache WHERE cache_key = $1`, [key]);
    return row ? { body: row.body, fetchedAt: row.fetched_at } : undefined;
  },
  async set(key, body, at) {
    await q(`INSERT INTO price_cache (cache_key, provider, body, fetched_at) VALUES ($1, 'serpapi', $2, $3) ON CONFLICT (cache_key) DO UPDATE SET body = EXCLUDED.body, fetched_at = EXCLUDED.fetched_at`, [
      key,
      JSON.stringify(body),
      at,
    ]);
  },
};

/** Geocoded places are cached next to prices (provider "open-meteo"). */
const geocodeCache: GeocodeCache = {
  get: (key) => priceCache.get(key),
  async set(key, body, at) {
    await q(`INSERT INTO price_cache (cache_key, provider, body, fetched_at) VALUES ($1, 'open-meteo', $2, $3) ON CONFLICT (cache_key) DO UPDATE SET body = EXCLUDED.body, fetched_at = EXCLUDED.fetched_at`, [
      key,
      JSON.stringify(body),
      at,
    ]);
  },
};

/** A place by name: the catalog first, then the map. Throws a ToolError the model can relay. */
export async function resolvePlace(input: string): Promise<Destination> {
  const known = findDestination(input);
  if (known) return known;
  let place;
  try {
    place = await geocodePlace(input, { cache: geocodeCache, now });
  } catch (err) {
    if (err instanceof GeocodeUnavailable) throw new ToolError(`couldn't look up "${input}" on the map right now; ask them to say it again in a bit`);
    throw err;
  }
  if (!place) throw new ToolError(`couldn't find a place called "${input}"; ask which town or area they mean (e.g. "lake lure, nc")`);
  return placeAsDestination(place);
}

let pricingFetch: typeof fetch = fetch;
/** Tests inject a fake SerpApi. */
export function setPricingFetch(f: typeof fetch): void {
  pricingFetch = f;
}

/** SerpApi access as the proposals use it (key, fetch, cache), for other features' live prices. */
export function pricingDeps(): PriceDeps {
  return { apiKey: config().SERPAPI_API_KEY, fetch: pricingFetch, cache: priceCache, now };
}

export interface StoredOption {
  destId: string;
  name: string;
  avgCents: number;
  minCents: number;
  maxCents: number;
  live: boolean;
  reasons: string[];
  /** The one reason printed under the option. */
  why?: string;
  perPerson: Record<string, CostBreakdown>;
  /** An off-catalog place (a re-vote against a geocoded place). */
  place?: TripPlace;
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length / 100) * 100 : 0);
/** Estimates read as round numbers: nearest $5. */
const round5 = (cents: number) => Math.round(cents / 500) * 500;
const liveTag = (c: CostBreakdown, k: "transport" | "lodging") => (c.sources[k].kind === "live" ? " live" : "");

const firstName = (label: string) => label.toLowerCase().split(/\s+/)[0]!;

/** Average transport by mode: drivers and flyers never blur into one "✈️" figure. */
function transportByMode(o: StoredOption): { mode: "drive" | "flight"; cents: number; ids: string[] }[] {
  const out: { mode: "drive" | "flight"; cents: number; ids: string[] }[] = [];
  for (const mode of ["drive", "flight"] as const) {
    const ids = Object.entries(o.perPerson).filter(([, c]) => c.transportMode === mode).map(([id]) => id);
    if (ids.length) out.push({ mode, cents: avg(ids.map((id) => o.perPerson[id]!.transportCents)), ids });
  }
  return out;
}

/** "2. gatlinburg — ~$630 each" / "🚗 $40 · 🏠 $105 · 🍽 $300" / why it fits. Every $ is a registered figure. */
function optionLine(i: number, o: StoredOption, label: (personId: number) => string = (id) => `#${id}`): string {
  const people = Object.values(o.perPerson);
  const sample = people[0]!;
  const spread = o.maxCents - o.minCents > 2_500 ? ` (${formatUsd(o.minCents)}–${formatUsd(o.maxCents)} by home city)` : "";
  const modes = transportByMode(o);
  const icon = (m: "drive" | "flight") => (m === "drive" ? "🚗" : "✈️");
  const transport =
    modes.length > 1
      ? modes.map((m) => `${icon(m.mode)} ${formatUsd(m.cents)} (${m.ids.map((id) => firstName(label(Number(id)))).join(", ")})`).join(" · ")
      : `${icon(modes[0]?.mode ?? sample.transportMode)} ${formatUsd(avg(people.map((c) => c.transportCents)))}${liveTag(sample, "transport")}`;
  const costs = [
    transport,
    `🏠 ${formatUsd(avg(people.map((c) => c.lodgingCents)))}${liveTag(sample, "lodging")}`,
    `🍽 ${formatUsd(avg(people.map((c) => c.foodCents + c.activitiesCents + c.localCents)))}`,
  ].join(" · ");
  const reason = o.why ?? o.reasons[0];
  const why = reason ? `\n${reason.toLowerCase()}` : "";
  return `${i + 1}. ${o.name.toLowerCase()} — ~${formatUsd(o.avgCents)} each${spread}\n${costs}${why}`;
}

function optionFigures(options: StoredOption[]): Figure[] {
  const out: Figure[] = [];
  for (const o of options) {
    out.push({ cents: o.avgCents, label: `${o.name} per person (avg)`, source: o.live ? "live:serpapi+estimate" : "estimate:catalog", visibility: "public" });
    out.push({ cents: o.minCents, label: `${o.name} cheapest per person`, source: "estimate:catalog", visibility: "public" });
    out.push({ cents: o.maxCents, label: `${o.name} priciest per person`, source: "estimate:catalog", visibility: "public" });
    const people = Object.values(o.perPerson);
    out.push({ cents: avg(people.map((c) => c.transportCents)), label: `${o.name} transport`, source: "estimate", visibility: "public" });
    for (const m of transportByMode(o)) out.push({ cents: m.cents, label: `${o.name} ${m.mode === "drive" ? "gas share" : "flights"}`, source: "estimate", visibility: "public" });
    out.push({ cents: avg(people.map((c) => c.lodgingCents)), label: `${o.name} lodging`, source: "estimate", visibility: "public" });
    out.push({ cents: avg(people.map((c) => c.foodCents + c.activitiesCents + c.localCents)), label: `${o.name} food + activities`, source: "estimate", visibility: "public" });
  }
  return out;
}

/** What's blocking, in plain words, from the filter's per-destination reasons. */
function explainRejections(rejected: Rejection[]): string {
  const kinds: [RegExp, string][] = [
    [/ceiling|budget/i, "over someone's budget"],
    [/veto|ruled out|doesn't want/i, "vetoed"],
    [/season|freezing|hurricane|too hot|too cold/i, "wrong season"],
    [/drive|fly|flight|passport/i, "outside someone's travel limits"],
    [/vegetarian|vegan|halal|kosher|gluten|dietary/i, "tough for someone's diet"],
  ];
  const byDest = new Map<string, Set<string>>();
  for (const r of rejected) {
    const kind = kinds.find(([re]) => re.test(r.reason))?.[1] ?? "doesn't fit";
    byDest.set(r.destinationId, (byDest.get(r.destinationId) ?? new Set()).add(kind));
  }
  const counts = new Map<string, number>();
  for (const set of byDest.values()) for (const k of set) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${n} places ${k}`).join(", ");
}

const NUMBER_WORDS = ["zero", "one", "two", "three"];
const VIBE_PLURAL: Partial<Record<Tag, string>> = { beach: "beaches", mountains: "mountains", snow: "snow spots", city: "cities", holiday: "christmas-market towns" };
const vibeWord = (t: Tag) => t.replace(/_/g, " ");
const vibePlural = (t: Tag) => VIBE_PLURAL[t] ?? `${vibeWord(t)} spots`;
const joinWords = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export interface ProposeOpts {
  nights?: number;
  tier?: "budget" | "mid";
  exclude?: string[];
  /** The setting(s) the group asked for ("beach", ["snow", "beach"]). Empty: inferred from likes. */
  vibe?: Tag[];
  /** Group-wide limits said out loud this time. */
  ask?: GroupAsk;
  /** The group pushed back on the last options: leave all of them out. */
  redo?: boolean;
  /** One line acknowledging what changed ("fair, beaches only this time"). */
  leadIn?: string;
  /** Re-vote between exactly these destinations (reopen). */
  only?: Destination[];
}

/** The header: the count it names always matches the options posted. */
export function proposalHeader(count: number, when: string, opts: { vibe?: Tag; leadIn?: string; anyLive?: boolean; revote?: boolean } = {}): string {
  const v = opts.vibe ? `${vibeWord(opts.vibe)} ` : "";
  const pricesOnly = `per person for ${when}, ${opts.anyLive ? "live fares where it says live, everything else is an estimate" : "prices are estimates"}`;
  if (opts.revote && opts.leadIn) return `${opts.leadIn.trim().replace(/\s*👇\s*$/u, "")} 👇\n${pricesOnly}`;
  const what =
    count >= 3 ? `three ${v}options for ${when}` : count === 2 ? `two ${v}spots fit everyone for ${when}` : `only one ${v}spot fits everyone for ${when}, here it is`;
  const prices = `per person, ${opts.anyLive ? "live fares where it says live, everything else is an estimate" : "prices are estimates"}`;
  const lead = opts.leadIn?.trim().replace(/\s*👇\s*$/u, "");
  return lead ? `${lead} 👇\n${what}, ${prices}` : `${count >= 3 ? "ok, " : ""}${what} 👇\n${prices}`;
}

/** Build, price and post up to three options with a poll. Returns what happened for the model. */
export async function proposeDestinations(tc: TurnCtx, opts: ProposeOpts = {}): Promise<{ posted: boolean; options: StoredOption[]; why?: string; note?: string }> {
  const view = await tc.view();
  const budgets = await budgetRows(tc.trip.id);
  const built = buildConstraints(view, budgets, { tripStart: tc.trip.start_date, tripEnd: tc.trip.end_date, nights: opts.nights, tier: opts.tier });
  const group = opts.ask ? applyGroupAsk(built.group, opts.ask) : built.group;
  const months = tripMonths(group.startDate, group.endDate);

  const excluded = new Set((opts.exclude ?? []).map((x) => findDestination(x)?.id).filter((x): x is string => Boolean(x)));
  const last = await one<{ options: StoredOption[] }>(`SELECT options FROM proposals WHERE trip_id = $1 ORDER BY id DESC LIMIT 1`, [tc.trip.id]);
  if (opts.redo && !opts.only) for (const o of last?.options ?? []) excluded.add(o.destId);
  const catalog = opts.only ?? destinations().filter((d) => !excluded.has(d.id));
  const { passed, rejected } = hardFilter(catalog, group);
  if (opts.only) {
    // A re-vote is between exactly these places, even if a fresh remark ("way cheaper") now trips a filter.
    const size = Math.max(1, group.members.length);
    for (const d of opts.only) {
      if (passed.some((p) => p.dest.id === d.id)) continue;
      passed.push({ dest: d, perPerson: new Map(group.members.map((m) => [m.personId, estimateCost(d, m, group.nights, group.tier, size)])) });
    }
  }

  const explicit = opts.only ? [] : (opts.vibe ?? []);
  const vibes = opts.only ? [] : explicit.length ? explicit : inferVibe(built.prefs);
  const vibeNames = joinWords(vibes.map(vibeWord));
  if (passed.length === 0) {
    const why = explainRejections(rejected);
    say(tc, `nothing in my list fits everyone yet (${why || "too many constraints"}). want to stretch the budget, loosen dates, or stay closer to home?`);
    return { posted: true, options: [], why };
  }
  const month = built.dates ? Number(built.dates.start.slice(5, 7)) : undefined;
  const all = scoreDestinations(passed, group, built.prefs, month);
  const vibe = applyVibe(all, vibes, months);
  let scored = vibe.kept;

  // Honest notes when a vibe couldn't be fully honoured (only said for vibes the group asked for or clearly leans to).
  const notes: string[] = [];
  for (const { tag, count } of vibe.short) {
    const tagged = catalog.filter((d) => hasTag(d, tag, months)).map((d) => d.id);
    const why = explainRejections(rejected.filter((r) => tagged.includes(r.destinationId)));
    if (count === 0) notes.push(`no ${vibeWord(tag)} spots fit everyone${why ? ` (${why})` : ""}, so here's what does`);
    else if (!vibe.strict) notes.push(`only one ${vibeWord(tag)} spot fits everyone, so i added a couple of others`);
  }

  // Live prices for the top five, then re-check everyone's ceiling against them.
  const cfg = config();
  if (built.dates) {
    const top = scored.slice(0, 5);
    const priced: Scored[] = [];
    for (const s of top) {
      try {
        const perPerson = await priceOption(s.dest, group.members, built.dates, group.tier, { apiKey: cfg.SERPAPI_API_KEY, fetch: pricingFetch, cache: priceCache, now });
        const over = group.members.some((m) => m.budgetCeilingCents !== undefined && (perPerson.get(m.personId)?.totalCents ?? 0) > m.budgetCeilingCents);
        if (!over || opts.only) priced.push({ ...s, perPerson });
      } catch {
        priced.push(s);
      }
    }
    scored = [...priced, ...scored.slice(5)];
  }
  const three = pickThree(scored, { cover: vibe.covered, months });
  if (three.length === 0) {
    say(tc, `nothing fits everyone once i checked live prices. want to stretch the budget or loosen dates?`);
    return { posted: true, options: [], why: "over budget at live prices" };
  }
  const options: StoredOption[] = three.map((s) => {
    const totals = [...s.perPerson.values()].map((c) => c.totalCents);
    return {
      destId: s.dest.id,
      name: s.dest.name,
      avgCents: round5(avg(totals)),
      minCents: round5(Math.min(...totals)),
      maxCents: round5(Math.max(...totals)),
      live: [...s.perPerson.values()].some((c) => c.sources.transport.kind === "live" || c.sources.lodging.kind === "live"),
      reasons: s.reasons,
      why: bestReason(s, { groupSize: group.members.length, vibe: vibes }),
      perPerson: Object.fromEntries([...s.perPerson].map(([id, c]) => [String(id), c])),
      ...(placeOf(s.dest) ? { place: placeOf(s.dest) } : {}),
    };
  });

  await tc.nonCancellable();
  const proposal = await one<{ id: number }>(`INSERT INTO proposals (trip_id, options, inputs, created_at) VALUES ($1,$2,$3,$4) RETURNING id`, [
    tc.trip.id,
    JSON.stringify(options),
    JSON.stringify({ group, prefs: built.prefs, notes: built.notes, vibe: vibes, ask: opts.ask ?? null }),
    tc.now,
  ]);
  const poll = await createPoll({
    tripId: tc.trip.id,
    chatId: tc.chat.id,
    kind: "destination",
    title: "where to?",
    options: options.map((o) => ({ title: `${o.name} (~${formatUsd(o.avgCents)})`, ref: o.destId, estimatedCostCents: o.avgCents })),
    proposalId: proposal!.id,
    at: tc.now,
  });
  if (tc.trip.status === "planning") tc.trip = await updateTrip(tc.trip.id, { status: "voting" });
  await setStage(tc.trip.id, "location", "in_progress");

  tc.figures.addAll(optionFigures(options));
  const when = built.dates ? formatRange(built.dates.start, built.dates.end) : `${group.nights} nights, dates tbd`;
  const anyLive = options.some((o) => o.live);
  const single = vibe.strict && vibes.length === 1 ? vibes[0] : undefined;
  let leadIn = opts.leadIn;
  if (!leadIn && notes.length) leadIn = notes[0];
  else if (!leadIn && opts.redo && vibe.strict) leadIn = `fair, ${joinWords(vibes.map(vibePlural))} only this time`;
  say(tc, proposalHeader(options.length, when, { vibe: single, leadIn, anyLive, revote: Boolean(opts.only) && options.length > 1 }));
  for (const [i, o] of options.entries()) say(tc, optionLine(i, o, (id) => tc.label(id)));
  // One spot is a yes/no, not a poll ("1" or "lock it" still decides it through the open poll row).
  if (options.length === 1) {
    say(tc, `that's the one that fits everyone. lock in ${options[0]!.name.toLowerCase()}? say "lock it", or ask me for more options`);
    return { posted: true, options, note: notes.join("; ") || undefined };
  }
  tc.out.push({ type: "poll", title: options.length === 2 && opts.only ? `${options[0]!.name.toLowerCase()} or ${options[1]!.name.toLowerCase()}? 🗳️` : "where are we going? tap to vote 🗳️", options: poll.options.map((o) => o.title), pollId: poll.id });
  return { posted: true, options, note: notes.join("; ") || (vibes.length ? `matched vibe: ${vibeNames}` : undefined) };
}

// ---------- votes ----------

function optionIndexFor(poll: PollRow, title: string): number {
  const t = title.trim().toLowerCase();
  const exact = poll.options.findIndex((o) => o.title.toLowerCase() === t);
  if (exact >= 0) return exact;
  return poll.options.findIndex((o) => t.startsWith(o.title.toLowerCase().split(" (")[0]!));
}

const optionName = (poll: PollRow, i: number) => (poll.options[i]?.title.split(" (")[0] ?? "").toLowerCase();

function tallyPoll(poll: PollRow, votes: { personId: number; optionIdx: number; selected: boolean }[], groupSize: number) {
  return tally(poll.options.length, votes, groupSize, poll.options.map((o) => o.estimatedCostCents ?? 0));
}

/** Tie announcements already posted, by poll and vote counts (so a tie is called out once). */
const tiesPosted = new Set<string>();
/** People already told a poll is closed, by poll (at most once each). */
const lateVoteReplies = new Set<string>();

/** "pick for us", "you pick", "atlas decide": the group hands a tied poll to Atlas. */
export const PICK_FOR_US = /\b(?:pick for us|you pick|you choose|you decide|(?:just )?pick (?:one|for us|it)|atlas,? (?:pick|choose|decide)|go with the cheaper(?: one)?|cheaper one|break the tie|tiebreak(?:er)?|flip a coin)\b/i;

/** Quiet this long after a poll's latest vote, Atlas names who hasn't voted (once per poll). */
export const POLL_REMIND_MS = 30_000;
export const POLL_REMIND_JOB = "poll.remind";
/** "skip", "move on", "just decide": close the poll with the votes that are in. */
export const SKIP_POLL = /^\W*(?:(?:ok|okay|yeah|ya|atlas)\W+)*(?:skip(?: (?:it|them|him|her|that))?|just skip|move on|let'?s move on|just decide|decide|go with (?:it|that|what we(?:'ve)? (?:have|got))|close (?:the |it|the poll)?(?: poll)?|we'?re good|that'?s everyone|call it)\W*$/i;

/** Push the "who hasn't voted" check to 30 s after this vote. */
async function schedulePollReminder(poll: PollRow, at: Date): Promise<void> {
  const key = `poll-remind:${poll.id}`;
  const due = new Date(at.getTime() + POLL_REMIND_MS);
  await enqueueJob(POLL_REMIND_JOB, { pollId: poll.id }, { dueAt: due, singletonKey: key });
  await rescheduleSingleton(key, due);
}

const memberFirstName = (p: { display_name: string | null; handle: string | null }) => labelOf(p).toLowerCase().split(/\s+/)[0] ?? "";

/** The poll.remind job: most of the group voted, the rest went quiet for 30 s — name them, once. */
export async function remindPoll(pollId: number, at: Date, post: (chatId: number, guid: string, text: string) => Promise<void>): Promise<"posted" | "rescheduled" | "skipped"> {
  const poll = await pollById(pollId);
  if (!poll || poll.status !== "open" || poll.reminded_at) return "skipped";
  const latest = await one<{ at: Date | null }>(`SELECT max(voted_at) AS at FROM votes WHERE poll_id = $1`, [pollId]);
  if (latest?.at && at.getTime() - latest.at.getTime() < POLL_REMIND_MS - 1_000) return "rescheduled";
  const members = await activeMembers(poll.chat_id);
  const votes = await votesFor(pollId);
  const result = tallyPoll(poll, votes, members.length);
  if (result.decided || result.deadlocked) return "skipped";
  const voted = new Set(votes.filter((v) => v.selected).map((v) => v.personId));
  const missing = members.filter((m) => !voted.has(m.id));
  // "Most of the group": at least half in, and someone still out.
  if (missing.length === 0 || voted.size * 2 < members.length) return "skipped";
  await q(`UPDATE polls SET reminded_at = $2 WHERE id = $1 AND reminded_at IS NULL`, [pollId, at]);
  const names = missing.map(memberFirstName).filter(Boolean);
  await post(poll.chat_id, `poll-remind-${pollId}`, `still waiting on ${joinWords(names)} 🗳️ ${voted.size} of ${members.length} are in\n${missing.length === 1 ? names[0] : "you all"} can vote on the poll above, or anyone say "skip" and i'll go with what we've got`);
  return "posted";
}

/** "skip" on an open poll: decide with the votes that are in (ties go to the cheaper option). */
async function skipPoll(msg: MessageRow, tc: TurnCtx, polls: PollRow[]): Promise<boolean> {
  if (!SKIP_POLL.test(msg.text)) return false;
  for (const poll of polls) {
    const votes = await votesFor(poll.id);
    const result = tallyPoll(poll, votes, tc.members.length);
    if (result.leader === null) {
      say(tc, "nobody's voted yet, so there's nothing to go with. tap the poll above first 🗳️");
      return true;
    }
    const top = Math.max(...result.counts);
    const how = `${result.voters} of ${tc.members.length} voted${result.tie ? `, tied ${result.counts.filter((c) => c === top).join("–")} so the cheaper one` : ""}`;
    await decidePoll(poll, result.leader, top, tc, how);
    return true;
  }
  return false;
}

/** The tie line: "it's a tie: atlanta 2, asheville 2. anyone want to switch? ..." */
export function tieMessage(names: string[], counts: number[], leader: number, priced: boolean): string {
  const top = Math.max(...counts);
  const tied = counts.flatMap((c, i) => (c === top ? [`${names[i]} ${c}`] : []));
  const fallback = priced ? `or i'll go with the cheaper one (${names[leader]})` : `or i'll pick ${names[leader]}`;
  return `it's a tie: ${tied.join(", ")}. anyone want to switch? ${fallback}, say "pick for us"`;
}

/** Tally and, when the poll is decided, lock it in (proactively: nobody has to ask). True if decided. */
export async function afterVote(poll: PollRow, tc: TurnCtx, voterId: number | null, source: "native" | "tapback" | "text" | "agent" | "sync", msg: MessageRow | null): Promise<boolean> {
  // Voting on another trip's poll makes that trip the one the chat is working on.
  if (poll.trip_id !== tc.trip.id) tc.trip = await focusTrip(tc.chat.id, poll.trip_id);
  const votes = await votesFor(poll.id);
  const result = tallyPoll(poll, votes, tc.members.length);
  if (result.decided && result.winner !== null) {
    await decidePoll(poll, result.winner, result.counts[result.winner]!, tc);
    return true;
  }
  if (result.deadlocked && result.leader !== null) {
    const key = `${poll.chat_id}:${poll.id}:${poll.created_at.getTime()}:${result.counts.join(",")}`;
    if (!tiesPosted.has(key)) {
      tiesPosted.add(key);
      const names = poll.options.map((_, i) => optionName(poll, i));
      say(tc, tieMessage(names, result.counts, result.leader, poll.options.some((o) => (o.estimatedCostCents ?? 0) > 0)));
    }
    return false;
  }
  // Not decided yet: stay quiet for now, and check back in 30 s for whoever hasn't voted.
  await schedulePollReminder(poll, tc.now).catch(() => {});
  // Native votes already show on the poll; a text vote gets a tapback.
  if (source === "text" && msg && voterId !== null) {
    const choice = poll.options[votes.filter((v) => v.personId === voterId && v.selected).at(-1)?.optionIdx ?? 0]?.title.split(" (")[0] ?? "";
    tc.out.push({ type: "react", targetId: msg.provider_message_id, tapback: "like", fallbackText: `got it: ${tc.label(voterId).toLowerCase()} → ${choice.toLowerCase()} (${result.voters} of ${tc.members.length} voted)` });
  }
  return false;
}

/** Close a decided poll and act on it: lock a destination, announce a custom result, or hand to the feature that owns it. */
async function decidePoll(poll: PollRow, winner: number, count: number, tc: TurnCtx, how?: string): Promise<void> {
  await tc.nonCancellable();
  if (poll.trip_id !== tc.trip.id) tc.trip = await focusTrip(tc.chat.id, poll.trip_id);
  await closePoll(poll.id, winner, tc.now);
  let handled = false;
  if (poll.kind === "destination") handled = await lockFromPoll(poll, winner, count, tc, how);
  else if (poll.kind === CUSTOM_POLL_KIND) handled = await customPollDecided(poll, winner, count, tc, how);
  for (const f of tc.features) if (!handled && f.onPollDecided) handled = await f.onPollDecided(poll, winner, tc);
}

/** "pick for us" while everyone's voted and it's tied: go with the cheaper (else first) tied option. */
async function resolveTieByAsk(msg: MessageRow, tc: TurnCtx, polls: PollRow[]): Promise<boolean> {
  if (!PICK_FOR_US.test(msg.text)) return false;
  for (const poll of polls) {
    const result = tallyPoll(poll, await votesFor(poll.id), tc.members.length);
    if (!result.tie || result.leader === null || result.voters * 2 < tc.members.length) continue;
    const top = Math.max(...result.counts);
    const priced = poll.options.some((o) => (o.estimatedCostCents ?? 0) > 0);
    await decidePoll(poll, result.leader, top, tc, priced ? `the cheaper one, it was ${result.counts.filter((c) => c === top).join("–")}` : "you asked me to pick");
    return true;
  }
  return false;
}

/** A vote on a poll that's already closed after the trip locked: say so once per person instead of going silent. */
async function lateVote(msg: MessageRow, tc: TurnCtx): Promise<boolean> {
  if (msg.person_id === null) return false;
  const poll =
    msg.kind === "poll_vote"
      ? await closedPollFor(tc.chat.id, { providerPollId: (msg.meta.pollMessageId as string | null) ?? null })
      : msg.kind === "reaction" && (msg.meta.tapback === "like" || msg.meta.tapback === "love") && msg.meta.removed !== true
        ? await closedPollFor(tc.chat.id, { optionMessageId: String(msg.meta.targetId ?? "") || null })
        : undefined;
  if (!poll) return false;
  const key = `${poll.chat_id}:${poll.id}:${poll.created_at.getTime()}:${msg.person_id}`;
  if (lateVoteReplies.has(key)) return true;
  lateVoteReplies.add(key);
  if (poll.kind === "destination" && tc.trip.destination_name && ["locked", "ongoing"].includes(tc.trip.status)) {
    say(tc, `voting's closed, we locked ${tc.trip.destination_name.toLowerCase()}. want to reopen it?`);
  } else if (poll.winner_idx !== null) {
    say(tc, `that poll's closed, ${optionName(poll, poll.winner_idx)} won`);
  } else {
    return true; // superseded by a newer poll: the new one is right there
  }
  return true;
}

// ---------- custom polls ("make a poll ski vs beach") ----------

export const CUSTOM_POLL_KIND = "custom";

async function customPollDecided(poll: PollRow, winner: number, count: number, tc: TurnCtx, how?: string): Promise<boolean> {
  const name = optionName(poll, winner);
  const n = tc.members.length;
  say(tc, `🗳️ ${name} wins${how ? ` (${how})` : count >= n && n > 1 ? `, unanimous` : ` (${count} of ${n})`}`);
  // A vibe poll ("ski or beach?") feeds straight into options, if we're still choosing where to go.
  const tags = vibeTags(String(poll.options[winner]?.ref ?? poll.options[winner]?.title ?? ""));
  const allVibes = poll.options.every((o) => vibeTags(String(o.ref ?? o.title)).length > 0);
  if (allVibes && tags.length && (tc.trip.status === "planning" || tc.trip.status === "voting")) {
    await proposeDestinations(tc, { vibe: tags, leadIn: `${name} it is, here's where` });
  }
  return true;
}

// ---------- reconciling native polls with the provider's voter list ----------

/** A native poll as the provider reports it: every option with everyone currently voting for it. */
export interface ProviderPollSnapshot {
  options: { id?: string; text: string; voters: { handle: string; votedAt?: Date }[] }[];
}
export type PollSource = (providerPollId: string) => Promise<ProviderPollSnapshot | undefined>;

let pollSource: PollSource | undefined;
/** Where native polls' voter lists come from (Linq: `setPollSource(linqPollSource(api))`). Unset = no reconciliation. */
export function setPollSource(fn: PollSource | undefined): void {
  pollSource = fn;
}

/** "everyone voted", "we all voted", "voted", "done voting", "check the poll"… while a native poll is open. */
const VOTED_SIGNAL =
  /\b(?:every(?:one|body)|we(?: all)?|all of us|y'?all|i|just|also)\s+(?:has\s+|have\s+|already\s+|just\s+|all\s+)*voted\b|^\W*(?:just\s+)?voted\W*$|\bdone voting\b|\b(?:check|look at|see) the poll\b|\bdid (?:every(?:one|body)|we all) vote\b/i;

async function personForHandle(chatId: number, handle: string, at: Date): Promise<number | undefined> {
  const known = await one<{ id: number }>(`SELECT id FROM people WHERE handle = $1`, [handle]);
  const id = known?.id ?? (await upsertPerson(handle, at)).id;
  // They voted in this chat's poll, so they're in the chat (even if Atlas hadn't heard from them).
  const member = await one(`SELECT 1 FROM chat_members WHERE chat_id = $1 AND person_id = $2 AND active`, [chatId, id]);
  if (!member) await ensureMember(chatId, id, at);
  return id;
}

/** The provider's votes mapped onto this poll's options and Atlas's people, or undefined if unavailable. */
async function providerVotes(poll: PollRow, at: Date): Promise<ProviderVote[] | undefined> {
  if (!pollSource || poll.rendered_as !== "native" || !poll.provider_poll_id) return undefined;
  let snap: ProviderPollSnapshot | undefined;
  try {
    snap = await pollSource(poll.provider_poll_id);
  } catch {
    return undefined;
  }
  if (!snap || snap.options.length === 0) return undefined;
  const out: ProviderVote[] = [];
  for (const [i, o] of snap.options.entries()) {
    let idx = poll.options.findIndex((p) => p.title === o.text);
    if (idx < 0) idx = optionIndexFor(poll, o.text);
    if (idx < 0 && snap.options.length === poll.options.length) idx = i; // same poll, retitled
    if (idx < 0) continue;
    for (const v of o.voters) {
      const personId = await personForHandle(poll.chat_id, v.handle, at);
      if (personId !== undefined) out.push({ personId, optionIdx: idx, votedAt: v.votedAt });
    }
  }
  return out;
}

/** Make Atlas's votes match the provider's voter list. Idempotent; returns how many rows changed. */
export async function reconcilePollVotes(poll: PollRow, at: Date): Promise<number> {
  const provider = await providerVotes(poll, at);
  if (!provider) return 0;
  const changes = reconcileVotes(await voteRows(poll.id), provider, { now: at });
  for (const c of changes) await setVote(poll.id, c.personId, c.optionIdx, c.selected, c.source, c.at);
  return changes.length;
}

/**
 * Startup: for every open native poll whose provider voter list differs from Atlas's (votes that
 * arrived while Atlas was down, or webhooks it couldn't read), queue a sync marker and run a turn
 * for that chat. The turn reconciles and, if the poll is now decided, posts the lock-in on its
 * own. Returns how many chats were poked. Never throws for one bad poll.
 */
export async function reconcileOpenNativePolls(svc: Pick<AppServices, "poke">, at: Date = now()): Promise<number> {
  let poked = 0;
  for (const poll of await openNativePolls()) {
    try {
      const provider = await providerVotes(poll, at);
      if (!provider) continue;
      const stored = await voteRows(poll.id);
      const changes = reconcileVotes(stored, provider, { now: at });
      const members = await activeMembers(poll.chat_id);
      const decided = tally(poll.options.length, stored, members.length, poll.options.map((o) => o.estimatedCostCents ?? 0)).decided;
      if (changes.length === 0 && !decided) continue;
      const personId = provider[0]?.personId ?? stored[0]?.personId ?? members[0]?.id;
      if (personId === undefined) continue;
      await insertMessage({
        chatId: poll.chat_id,
        personId,
        providerMessageId: `poll-sync:${poll.id}:${at.getTime()}`,
        direction: "inbound",
        kind: "poll_vote",
        text: "(poll votes synced)",
        meta: { pollSync: true, pollId: poll.id, pollMessageId: poll.provider_poll_id },
        sentAt: at,
        receivedAt: at,
        speakable: false,
      });
      await svc.poke(poll.chat_id);
      poked += 1;
    } catch {
      // One unreadable poll never blocks the rest (or startup).
    }
  }
  return poked;
}

async function lockFromPoll(poll: PollRow, winner: number, count: number, tc: TurnCtx, how?: string): Promise<boolean> {
  const destId = String(poll.options[winner]?.ref ?? "");
  let dest = destinationById(destId);
  if (!dest && destId.startsWith("place:") && poll.proposal_id) {
    const row = await one<{ options: StoredOption[] }>(`SELECT options FROM proposals WHERE id = $1`, [poll.proposal_id]);
    const place = row?.options.find((o) => o.destId === destId)?.place;
    if (place) dest = placeAsDestination(place);
  }
  if (!dest) return false;
  const name = dest.name.toLowerCase();
  const n = tc.members.length;
  const headline = how ? `🎉 going with ${name}, ${how}` : count >= n && n > 1 ? `🎉 ${name} it is! unanimous, ${count} for ${n}` : `🎉 ${name} it is! ${count} of ${n} votes`;
  await lockDestination(tc, dest, headline);
  return true;
}

/**
 * Lock the destination + dates, post booking links, fire trip-locked hooks. The day-by-day plan
 * comes later (after the stay and food & activities); a plan for a different place is cleared.
 */
export async function lockDestination(tc: TurnCtx, dest: Destination, headline: string): Promise<void> {
  await tc.nonCancellable();
  const view = await tc.view();
  const start = tc.trip.start_date ?? view.dates?.start ?? null;
  const end = tc.trip.end_date ?? view.dates?.end ?? null;
  const same = tripDestination(tc.trip)?.id === dest.id;
  const itinerary = same ? tc.trip.itinerary : [];
  const place = placeOf(dest);
  // A different place than the one already decided: everything after location starts over.
  if (!same && (await getStages(tc.trip.id)).location === "decided") {
    await reopenStage(tc.trip.id, "location");
    await resetTravelPlans(tc.trip.id);
  }
  tc.trip = await updateTrip(tc.trip.id, {
    ...(same ? {} : { plan_written_at: null }),
    status: "locked",
    destination_id: place ? null : dest.id,
    destination_place: place ?? null,
    destination_name: dest.name,
    latitude: dest.lat,
    longitude: dest.lon,
    start_date: start,
    end_date: end,
    itinerary: itinerary as never,
    locked_at: tc.now,
  });
  for (const p of await openPolls(tc.chat.id, tc.trip.id)) if (p.kind === "destination") await closePoll(p.id, null, tc.now);
  await setStage(tc.trip.id, "location", "decided");
  if (start && end) await setStage(tc.trip.id, "dates", "decided");
  tc.trip = { ...tc.trip, stages: await getStages(tc.trip.id) };
  say(tc, `${headline}\n${start && end ? `locked in for ${formatRange(start, end)}` : "locked in. now we just need dates"}`);
  if (start && end) {
    // Flight links only for people who fly there (drivers and anyone who can't fly get none).
    const proposal = await one<{ options: StoredOption[] }>(`SELECT options FROM proposals WHERE trip_id = $1 ORDER BY id DESC LIMIT 1`, [tc.trip.id]);
    const option = proposal?.options.find((o) => o.destId === dest.id);
    const members = buildConstraints(view, [], { tripStart: start, tripEnd: end }).group;
    const flies = (personId: number): boolean => {
      const m = members.members.find((x) => x.personId === personId);
      if (m?.noFlying) return false;
      const stored = option?.perPerson[String(personId)];
      if (stored) return stored.transportMode === "flight";
      return m ? travelPlan(dest, m, members.nights).mode === "flight" : true;
    };
    const iatas = [
      ...new Set(
        view.members
          .filter((m) => flies(m.personId))
          .map((m) => (m.profile.homeCity ? resolveHome(m.profile.homeCity.value)?.iata : undefined))
          .filter((x): x is string => Boolean(x) && x !== dest.iata),
      ),
    ];
    const flights = iatas.slice(0, 3).map((o) => ({ from: o, url: googleFlightsLink(o, dest.iata || dest.name, start, end) }));
    const stays = googleHotelsLink(dest.name, start, end, Math.min(tc.members.length, 4));
    say(tc, [`ready to book? links 👇`, ...flights.map((f) => `✈️ from ${f.from.toLowerCase()}: ${f.url}`), `🏠 stays: ${stays}`].join("\n"));
    // The trip page lists the same links.
    const booking = [...flights.map((f) => ({ label: `flights from ${f.from}`, url: f.url })), { label: "stays", url: stays }];
    tc.trip = await updateTrip(tc.trip.id, { booking });
  }
  await fireTripLocked(tc.trip, tc);
}

// ---------- tools ----------

const boolArg = (v: unknown): boolean => v === true || v === "true";

const proposeTool: Tool = {
  decl: {
    name: "propose_destinations",
    description:
      "Find up to three destinations that fit everyone's hard constraints (dates, diets, budgets, vetoes, travel limits) and preferences, price them (live fares when available, otherwise labeled estimates), and post them with a poll. Posts its own messages. Pass what the group just asked for: vibe for a setting (\"beach trip\" → [\"beach\"], \"mountains or christmas markets\" → [\"mountains\",\"holiday\"], split group \"ski vs beach\" → [\"snow\",\"beach\"] gives one option of each), max_per_person_usd for \"under 800\", drive_only / max_drive_hours only when the whole group asks (\"anything drivable\", \"all of us within 5 hours\"); one person's own limits (\"i can't fly\") are already applied to just them. When they pushed back on the last options (\"these aren't even beaches\", \"we said mountains\"), set redo=true plus the vibe, and a one-line lead_in.",
    parameters: {
      type: "object",
      properties: {
        nights: { type: "integer", description: "trip length if the group said one" },
        tier: { type: "string", enum: ["budget", "mid"] },
        exclude: { type: "array", items: { type: "string" }, description: "places to leave out (already rejected)" },
        vibe: {
          type: "array",
          items: { type: "string", enum: ["beach", "mountains", "snow", "city", "holiday", "food", "nightlife", "outdoors", "hiking", "culture", "music", "relaxing", "adventure", "history"] },
          description: "setting(s) the group asked for; options are limited to these (one of each when several)",
        },
        max_per_person_usd: { type: "number", description: "a per-person cap the group just said out loud" },
        drive_only: { type: "boolean", description: "the whole group wants somewhere everyone drives to (not for one person's limit)" },
        max_drive_hours: { type: "number", description: "longest one-way drive the whole group will do (implies everyone drives; not for one person's limit)" },
        redo: { type: "boolean", description: "true when the group rejected the last options; leaves all of them out" },
        lead_in: { type: "string", description: "one short line acknowledging the change, e.g. \"fair, beaches only this time\"" },
      },
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const r = await proposeDestinations(tc, {
      nights: num(args.nights),
      tier: args.tier === "budget" || args.tier === "mid" ? args.tier : undefined,
      exclude: strList(args.exclude),
      vibe: vibeTags(args.vibe),
      ask: { driveOnly: boolArg(args.drive_only), maxDriveHours: num(args.max_drive_hours), maxPerPersonUsd: num(args.max_per_person_usd) },
      redo: boolArg(args.redo),
      leadIn: str(args.lead_in),
    });
    return {
      ok: true,
      data: { options: r.options.map((o) => ({ name: o.name, perPerson: formatUsd(o.avgCents), live: o.live })), why: r.why, note: r.note },
      next: "options and a poll were posted with their own header; reply NO_REPLY",
    };
  },
  soloPost: true,
};

const reopenTool: Tool = {
  decl: {
    name: "reopen_destination",
    description:
      "After a destination is locked, when the group wants to switch (\"actually can we do asheville instead?\"): unlocks the trip and posts a quick two-option poll, the locked place vs the new one. The poll decides and re-locks (payment plan and plan are redone then). If everyone clearly already agreed on the new place, use lock_destination instead.",
    parameters: { type: "object", properties: { destination: { type: "string", description: "the new place they want instead" } }, required: ["destination"] },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    if (!tc.trip.destination_name || !["locked", "voting"].includes(tc.trip.status)) throw new ToolError("nothing's locked yet; use propose_destinations or record_vote");
    const current = tripDestination(tc.trip);
    if (!current) throw new ToolError("the locked destination can't be found");
    const next = await resolvePlace(str(args.destination) ?? "");
    if (next.id === current.id) throw new ToolError(`${current.name} is already the pick`);
    // The new place still has to fit everyone's hard limits.
    const view = await tc.view();
    const built = buildConstraints(view, await budgetRows(tc.trip.id), { tripStart: tc.trip.start_date, tripEnd: tc.trip.end_date });
    const check = hardFilter([next], built.group);
    if (check.passed.length === 0) {
      return { ok: true, data: { reopened: false, why: [...new Set(check.rejected.map((r) => r.reason))].slice(0, 2) }, next: `say in one line why ${next.name} doesn't fit (the reasons above) and ask if they want to change that limit; the trip stays locked on ${current.name}` };
    }
    await tc.nonCancellable();
    tc.trip = await updateTrip(tc.trip.id, { status: "voting", destination_id: null, destination_place: null, destination_name: null, latitude: null, longitude: null, itinerary: [] as never, plan_written_at: null, locked_at: null });
    await reopenStage(tc.trip.id, "location");
    await resetTravelPlans(tc.trip.id);
    await proposeDestinations(tc, { only: [current, next], leadIn: `ok, quick re-vote: ${current.name.toLowerCase()} or ${next.name.toLowerCase()}? majority wins` });
    return { ok: true, data: { reopened: true }, next: "the re-vote poll was posted; reply NO_REPLY" };
  },
  soloPost: true,
};

const createPollTool: Tool = {
  decl: {
    name: "create_poll",
    description:
      "Post a quick native poll for any group question (\"make a poll ski vs beach\", \"friday or saturday?\"). 2–4 short options. When it's decided, the result is posted in one line; a vibe poll (options like ski/beach/mountains/city) then posts destination options for the winner automatically. For choosing between destinations use propose_destinations instead.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "short, lowercase, e.g. \"ski or beach?\"" },
        options: { type: "array", items: { type: "string" }, description: "2–4 short options" },
      },
      required: ["question", "options"],
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const question = (str(args.question) ?? "").slice(0, 80);
    const options = [...new Set(strList(args.options).map((o) => o.slice(0, 40)))];
    if (!question) throw new ToolError("question is required");
    if (options.length < 2 || options.length > 4) throw new ToolError("give 2–4 distinct options");
    await tc.nonCancellable();
    const poll = await createPoll({
      tripId: tc.trip.id,
      chatId: tc.chat.id,
      kind: CUSTOM_POLL_KIND,
      title: question,
      options: options.map((o) => ({ title: o, ref: vibeTags(o)[0] ?? o })),
      at: tc.now,
    });
    tc.out.push({ type: "poll", title: `${question} 🗳️`, options: poll.options.map((o) => o.title), pollId: poll.id });
    return { ok: true, next: "the poll was posted; at most a one-line lead-in, or NO_REPLY" };
  },
};

const recordVoteTool: Tool = {
  decl: {
    name: "record_vote",
    description: "Record one person's vote in the open destination poll when they said it in words the quick parser missed (\"i'm leaning san juan\"). One person's opinion is a vote, not a decision.",
    parameters: { type: "object", properties: { member: { type: "string" }, option_number: { type: "integer" } }, required: ["member", "option_number"] },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const poll = (await openPolls(tc.chat.id, tc.trip.id)).find((p) => p.kind === "destination");
    if (!poll) throw new ToolError("no destination poll is open");
    const who = tc.resolve(str(args.member) ?? "");
    const n = num(args.option_number);
    if (who === undefined) throw new ToolError(`unknown member ${String(args.member)}`);
    if (!n || n < 1 || n > poll.options.length) throw new ToolError(`option_number must be 1–${poll.options.length}`);
    await recordVote(poll.id, who, n - 1, true, "agent", tc.now, { single: true });
    await afterVote(poll, tc, who, "agent", null);
    return { ok: true, next: "vote saved" };
  },
};

const lockTool: Tool = {
  decl: {
    name: "lock_destination",
    description:
      "Lock in a destination when the group (\"we\", \"everyone\", a majority) has clearly decided, even outside the poll. Any real place works, including ones that weren't among the options (\"boone, nc\", \"lake lure\"): it's looked up on the map. Posts the lock-in and booking links itself. Works on an already-locked trip too (re-locks a new place); if only one person wants to switch, use reopen_destination for a quick re-vote instead.",
    parameters: { type: "object", properties: { destination: { type: "string", description: "option number or place name; add the state or country when it's ambiguous (\"portland, me\")" } }, required: ["destination"] },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const input = str(args.destination) ?? "";
    const poll = (await openPolls(tc.chat.id, tc.trip.id)).find((p) => p.kind === "destination");
    let dest: Destination | undefined;
    if (/^\d+$/.test(input) && poll) dest = destinationById(String(poll.options[Number(input) - 1]?.ref ?? ""));
    // Any real place works: the catalog first, then the map (off-catalog places get estimates).
    dest ??= await resolvePlace(input);
    const place = placeOf(dest);
    await lockDestination(tc, dest, `🎉 ${(place ? placeLabel(place) : dest.name).toLowerCase()} it is!`);
    return {
      ok: true,
      next: tc.trip.start_date
        ? "locked; the lock-in and booking links were posted. don't write the day-by-day plan yet (it comes after the stay and food & activities); reply NO_REPLY or one short line on the next step in plan stages"
        : "locked; the lock-in was posted. dates aren't set yet: the next step is the dates (find_dates)",
    };
  },
};

export const proposalsFeature: Feature = {
  name: "proposals",
  tools: [proposeTool, recordVoteTool, lockTool, reopenTool, createPollTool],

  jobs(svc) {
    return {
      [POLL_REMIND_JOB]: async (payload) => {
        const pollId = Number(payload.pollId);
        if (!Number.isInteger(pollId)) return;
        const at = now();
        const outcome = await remindPoll(pollId, at, (chatId, guid, text) => svc.post(chatId, guid, [{ type: "say", text }]));
        // A vote landed since this was scheduled: check again 30 s after that one.
        if (outcome === "rescheduled") return { rescheduleAt: new Date(at.getTime() + POLL_REMIND_MS) };
      },
    };
  },

  async fastPath(msg, tc) {
    if (msg.person_id === null) return false;
    // Native and tapback votes name their poll, so they match any trip's poll in the chat;
    // a typed vote ("2") goes to the focused trip's poll.
    const polls = await openPolls(tc.chat.id);
    if (polls.length === 0) return lateVote(msg, tc);

    if (msg.kind === "poll_vote") {
      const pollMessageId = msg.meta.pollMessageId as string | null;
      const title = String(msg.meta.optionTitle ?? "");
      const poll =
        (msg.meta.pollSync ? polls.find((p) => p.id === Number(msg.meta.pollId)) : undefined) ??
        polls.find((p) => p.provider_poll_id && p.provider_poll_id === pollMessageId) ??
        polls.find((p) => p.rendered_as === "native" && optionIndexFor(p, title) >= 0);
      if (!poll) return false;
      const idx = msg.meta.pollSync ? -1 : optionIndexFor(poll, title);
      if (idx >= 0) await recordVote(poll.id, msg.person_id, idx, msg.meta.selected !== false, "native", tc.now, { supersedeNonNative: true });
      // The provider's voter list is the truth: it also catches votes whose webhook was lost or unreadable.
      await reconcilePollVotes(poll, tc.now);
      await afterVote(poll, tc, msg.person_id, msg.meta.pollSync ? "sync" : "native", msg);
      return true;
    }
    if (msg.kind === "reaction") {
      const target = String(msg.meta.targetId ?? "");
      const tapback = msg.meta.tapback as string | null;
      if (tapback !== "like" && tapback !== "love") return false;
      const poll = polls.find((p) => p.option_message_ids.includes(target));
      if (!poll) return false;
      const idx = poll.option_message_ids.indexOf(target);
      await recordVote(poll.id, msg.person_id, idx, msg.meta.removed !== true, "tapback", tc.now, { single: true });
      await afterVote(poll, tc, msg.person_id, "tapback", msg);
      return true;
    }
    if (msg.kind === "text" && msg.speakable) {
      // Typed votes, "pick for us" and "skip" are about the trip the chat is working on.
      const mine = polls.filter((p) => p.trip_id === tc.trip.id);
      // "pick for us" on a tied poll: Atlas breaks the tie (cheaper option).
      if (await resolveTieByAsk(msg, tc, mine)) return true;
      // "skip": go with the votes that are in.
      if (await skipPoll(msg, tc, mine)) return true;
      const poll = mine.find((p) => p.kind === "destination") ?? mine[0];
      if (!poll) return false;
      const titles = poll.options.map((o) => o.title.split(" (")[0]!);
      const idx = parseVote(msg.text, titles);
      if (idx !== null) {
        // Counts the same as a native vote; one person never counts twice for voting both ways.
        await recordVote(poll.id, msg.person_id, idx, true, "text", tc.now, { single: true });
        await reconcilePollVotes(poll, tc.now);
        await afterVote(poll, tc, msg.person_id, "text", msg);
        return true;
      }
      // "everyone voted" with a native poll open: read the poll and, if it's decided, lock it in.
      // Otherwise let the turn carry on (the situation shows who's still missing).
      if (poll.rendered_as === "native" && VOTED_SIGNAL.test(msg.text)) {
        await reconcilePollVotes(poll, tc.now);
        if (await afterVote(poll, tc, null, "sync", null)) return true;
      }
      return false;
    }
    return false;
  },

  commands: {
    propose: async (_msg, tc) => {
      await proposeDestinations(tc);
    },
  },

  async figures(tc) {
    const row = await one<{ options: StoredOption[] }>(`SELECT options FROM proposals WHERE trip_id = $1 ORDER BY id DESC LIMIT 1`, [tc.trip.id]);
    return row ? optionFigures(row.options) : [];
  },

  async hints(tc) {
    const out: string[] = [];
    for (const p of await openPolls(tc.chat.id, tc.trip.id)) {
      const hours = (tc.now.getTime() - p.created_at.getTime()) / 3_600_000;
      const votes = await votesFor(p.id);
      const voters = new Set(votes.filter((v) => v.selected).map((v) => v.personId)).size;
      if (hours > 6 && voters * 2 <= tc.members.length) out.push(`the "${p.title}" poll has been open ${Math.round(hours)}h with only ${voters} of ${tc.members.length} votes — the decision is stuck`);
    }
    return out;
  },

  async situation(tc) {
    const lines: string[] = [];
    for (const p of await openPolls(tc.chat.id, tc.trip.id)) {
      const votes = await votesFor(p.id);
      const by = (i: number) => votes.filter((v) => v.optionIdx === i && v.selected).map((v) => tc.label(v.personId));
      lines.push(`open poll "${p.title}" (${p.rendered_as}): ${p.options.map((o, i) => `${i + 1}. ${o.title} [${by(i).join(", ") || "no votes"}]`).join("; ")}`);
      const t = tallyPoll(p, votes, tc.members.length);
      if (t.deadlocked && t.leader !== null) lines.push(`that poll is tied with everyone voted (tie message already posted); "pick for us" goes with ${optionName(p, t.leader)}`);
    }
    const custom = await lastDecidedPoll(tc.chat.id, CUSTOM_POLL_KIND);
    if (custom && custom.winner_idx !== null) lines.push(`last custom poll "${custom.title}": ${optionName(custom, custom.winner_idx)} won`);
    if (tc.trip.status === "locked" && tc.trip.destination_name) lines.push(`locked: ${tc.trip.destination_name}. to switch: reopen_destination (quick re-vote) or lock_destination if everyone agreed`);
    const row = await one<{ options: StoredOption[]; created_at: Date }>(`SELECT options, created_at FROM proposals WHERE trip_id = $1 ORDER BY id DESC LIMIT 1`, [tc.trip.id]);
    if (row) lines.push(`last proposal: ${row.options.map((o) => `${o.name} ~${formatUsd(o.avgCents)}pp${o.live ? " (live fares)" : " (est.)"}`).join(", ")}`);
    return lines.length ? { title: "proposals and polls", lines } : null;
  },

  async summary(tc) {
    const out: string[] = [];
    for (const p of await openPolls(tc.chat.id, tc.trip.id)) {
      const votes = await votesFor(p.id);
      out.push(`poll open: ${p.options.map((o, i) => `${o.title.split(" (")[0]} ${votes.filter((v) => v.optionIdx === i && v.selected).length}`).join(", ")}`);
    }
    return out;
  },
};
