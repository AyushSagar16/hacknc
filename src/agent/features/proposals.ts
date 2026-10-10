// Destination proposals and decisions. Hard constraints filter the catalog, soft preferences
// score it, the top candidates get live prices (SerpApi Google Flights/Hotels, cached) with
// labeled estimates as fallback, and three options go out with per-person cost breakdowns and
// a poll. Votes arrive as native poll votes, tapbacks on an option bubble, or plain text ("2",
// "lisbon"); a majority of the group (or everyone voting) decides and locks the trip in.
import { config } from "../../config.ts";
import { now } from "../../clock.ts";
import { formatUsd } from "../../money/cents.ts";
import { one, q } from "../../db/pool.ts";
import { activeMembers, ensureMember, insertMessage, upsertPerson, type MessageRow } from "../../db/repos/core.ts";
import { budgetRows } from "../../nessie/budgets.ts";
import { interestWeights } from "../../profile/groupView.ts";
import { destinationById, destinations, findDestination, type Destination } from "../../trips/catalog.ts";
import { buildConstraints } from "../../trips/constraints.ts";
import { hardFilter, type Rejection } from "../../trips/filter.ts";
import type { CostBreakdown } from "../../trips/estimate.ts";
import { draftItinerary } from "../../trips/itinerary.ts";
import { googleFlightsLink, googleHotelsLink } from "../../trips/links.ts";
import { closePoll, createPoll, openNativePolls, openPolls, recordVote, setVote, voteRows, votesFor, type PollRow } from "../../trips/pollStore.ts";
import { priceOption, type PriceCache } from "../../trips/pricing.ts";
import { pickThree, scoreDestinations, type Scored } from "../../trips/score.ts";
import { updateTrip } from "../../trips/state.ts";
import { parseVote, reconcileVotes, tally, type ProviderVote } from "../../trips/votes.ts";
import { formatRange } from "./planning.ts";
import { fireTripLocked, type AppServices, type Feature, type TurnCtx } from "../feature.ts";
import type { Figure } from "../figures.ts";
import { ToolError, num, say, str, type Tool } from "../tools.ts";

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

let pricingFetch: typeof fetch = fetch;
/** Tests inject a fake SerpApi. */
export function setPricingFetch(f: typeof fetch): void {
  pricingFetch = f;
}

interface StoredOption {
  destId: string;
  name: string;
  avgCents: number;
  minCents: number;
  maxCents: number;
  live: boolean;
  reasons: string[];
  perPerson: Record<string, CostBreakdown>;
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length / 100) * 100 : 0);
/** Estimates read as round numbers: nearest $5. */
const round5 = (cents: number) => Math.round(cents / 500) * 500;
const liveTag = (c: CostBreakdown, k: "transport" | "lodging") => (c.sources[k].kind === "live" ? " live" : "");

/** "2. gatlinburg — ~$630 each" / "✈️ $225 · 🏠 $105 · 🍽 $300" / why it fits. Every $ is a registered figure. */
function optionLine(i: number, o: StoredOption): string {
  const people = Object.values(o.perPerson);
  const sample = people[0]!;
  const spread = o.maxCents - o.minCents > 2_500 ? ` (${formatUsd(o.minCents)}–${formatUsd(o.maxCents)} by home city)` : "";
  const costs = [
    `${sample.transportMode === "drive" ? "🚗" : "✈️"} ${formatUsd(avg(people.map((c) => c.transportCents)))}${liveTag(sample, "transport")}`,
    `🏠 ${formatUsd(avg(people.map((c) => c.lodgingCents)))}${liveTag(sample, "lodging")}`,
    `🍽 ${formatUsd(avg(people.map((c) => c.foodCents + c.activitiesCents + c.localCents)))}`,
  ].join(" · ");
  const why = o.reasons.length ? `\n${o.reasons.slice(0, 2).join(", ").toLowerCase()}` : "";
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

/** Build, price and post three options with a poll. Returns what happened for the model. */
export async function proposeDestinations(tc: TurnCtx, opts: { nights?: number; tier?: "budget" | "mid"; exclude?: string[] } = {}): Promise<{ posted: boolean; options: StoredOption[]; why?: string }> {
  const view = await tc.view();
  const budgets = await budgetRows(tc.trip.id);
  const built = buildConstraints(view, budgets, { tripStart: tc.trip.start_date, tripEnd: tc.trip.end_date, nights: opts.nights, tier: opts.tier });
  const catalog = destinations().filter((d) => !(opts.exclude ?? []).some((x) => findDestination(x)?.id === d.id));
  const { passed, rejected } = hardFilter(catalog, built.group);
  if (passed.length === 0) {
    const why = explainRejections(rejected);
    say(tc, `nothing in my list fits everyone yet (${why || "too many constraints"}). want to stretch the budget, loosen dates, or stay closer to home?`);
    return { posted: true, options: [], why };
  }
  const month = built.dates ? Number(built.dates.start.slice(5, 7)) : undefined;
  let scored = scoreDestinations(passed, built.group, built.prefs, month);

  // Live prices for the top five, then re-check everyone's ceiling against them.
  const cfg = config();
  if (built.dates) {
    const top = scored.slice(0, 5);
    const priced: Scored[] = [];
    for (const s of top) {
      try {
        const perPerson = await priceOption(s.dest, built.group.members, built.dates, built.group.tier, { apiKey: cfg.SERPAPI_API_KEY, fetch: pricingFetch, cache: priceCache, now });
        const over = built.group.members.some((m) => m.budgetCeilingCents !== undefined && (perPerson.get(m.personId)?.totalCents ?? 0) > m.budgetCeilingCents);
        if (!over) priced.push({ ...s, perPerson });
      } catch {
        priced.push(s);
      }
    }
    scored = [...priced, ...scored.slice(5)];
  }
  const three = pickThree(scored);
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
      perPerson: Object.fromEntries([...s.perPerson].map(([id, c]) => [String(id), c])),
    };
  });

  await tc.nonCancellable();
  const proposal = await one<{ id: number }>(`INSERT INTO proposals (trip_id, options, inputs, created_at) VALUES ($1,$2,$3,$4) RETURNING id`, [
    tc.trip.id,
    JSON.stringify(options),
    JSON.stringify({ group: built.group, prefs: built.prefs, notes: built.notes }),
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

  tc.figures.addAll(optionFigures(options));
  const when = built.dates ? formatRange(built.dates.start, built.dates.end) : `${built.group.nights} nights, dates tbd`;
  const anyLive = options.some((o) => o.live);
  say(tc, `ok, three options for ${when} 👇\nper person, ${anyLive ? "live fares where it says live, everything else is an estimate" : "prices are estimates"}`);
  for (const [i, o] of options.entries()) say(tc, optionLine(i, o));
  tc.out.push({ type: "poll", title: "where are we going? tap to vote 🗳️", options: poll.options.map((o) => o.title), pollId: poll.id });
  return { posted: true, options };
}

// ---------- votes ----------

function optionIndexFor(poll: PollRow, title: string): number {
  const t = title.trim().toLowerCase();
  const exact = poll.options.findIndex((o) => o.title.toLowerCase() === t);
  if (exact >= 0) return exact;
  return poll.options.findIndex((o) => t.startsWith(o.title.toLowerCase().split(" (")[0]!));
}

/** Tally and, when the poll is decided, lock it in (proactively: nobody has to ask). True if decided. */
async function afterVote(poll: PollRow, tc: TurnCtx, voterId: number | null, source: "native" | "tapback" | "text" | "agent" | "sync", msg: MessageRow | null): Promise<boolean> {
  const votes = await votesFor(poll.id);
  const result = tally(
    poll.options.length,
    votes,
    tc.members.length,
    poll.options.map((o) => o.estimatedCostCents ?? 0),
  );
  if (result.decided && result.winner !== null) {
    await tc.nonCancellable();
    await closePoll(poll.id, result.winner, tc.now);
    let handled = false;
    if (poll.kind === "destination") handled = await lockFromPoll(poll, result.winner, result.counts[result.winner]!, tc);
    for (const f of tc.features) if (!handled && f.onPollDecided) handled = await f.onPollDecided(poll, result.winner, tc);
    return true;
  }
  // Not decided yet: stay quiet. Native votes already show on the poll; a text vote gets a tapback.
  if (source === "text" && msg && voterId !== null) {
    const choice = poll.options[votes.filter((v) => v.personId === voterId && v.selected).at(-1)?.optionIdx ?? 0]?.title.split(" (")[0] ?? "";
    tc.out.push({ type: "react", targetId: msg.provider_message_id, tapback: "like", fallbackText: `got it: ${tc.label(voterId).toLowerCase()} → ${choice.toLowerCase()} (${result.voters} of ${tc.members.length} voted)` });
  }
  return false;
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

async function lockFromPoll(poll: PollRow, winner: number, count: number, tc: TurnCtx): Promise<boolean> {
  const destId = String(poll.options[winner]?.ref ?? "");
  const dest = destinationById(destId);
  if (!dest) return false;
  const name = dest.name.toLowerCase();
  const n = tc.members.length;
  await lockDestination(tc, dest, count >= n && n > 1 ? `🎉 ${name} it is! unanimous, ${count} for ${n}` : `🎉 ${name} it is! ${count} of ${n} votes`);
  return true;
}

/** Lock the destination + dates, draft the itinerary, post links, fire trip-locked hooks. */
export async function lockDestination(tc: TurnCtx, dest: Destination, headline: string): Promise<void> {
  await tc.nonCancellable();
  const view = await tc.view();
  const start = tc.trip.start_date ?? view.dates?.start ?? null;
  const end = tc.trip.end_date ?? view.dates?.end ?? null;
  const itinerary = start && end ? draftItinerary(dest, start, end, interestWeights(view)) : [];
  tc.trip = await updateTrip(tc.trip.id, {
    status: "locked",
    destination_id: dest.id,
    destination_name: dest.name,
    latitude: dest.lat,
    longitude: dest.lon,
    start_date: start,
    end_date: end,
    itinerary: itinerary as never,
    locked_at: tc.now,
  });
  for (const p of await openPolls(tc.chat.id)) if (p.kind === "destination") await closePoll(p.id, null, tc.now);
  say(tc, `${headline}\n${start && end ? `locked in for ${formatRange(start, end)}` : "locked in. now we just need dates"}`);
  if (itinerary.length) {
    const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).toLowerCase();
    say(tc, `rough plan 🗺️\n${itinerary.map((d) => `${day(d.date)}: ${d.items.map((i) => i.name.toLowerCase()).join(", ") || "free day, do whatever"}`).join("\n")}`);
  }
  if (start && end) {
    // Flight links only for people the last proposal had flying (drivers get none).
    const proposal = await one<{ options: StoredOption[] }>(`SELECT options FROM proposals WHERE trip_id = $1 ORDER BY id DESC LIMIT 1`, [tc.trip.id]);
    const option = proposal?.options.find((o) => o.destId === dest.id);
    const flyers = new Set(Object.entries(option?.perPerson ?? {}).filter(([, c]) => c.transportMode === "flight").map(([id]) => Number(id)));
    const { resolveHome } = await import("../../trips/catalog.ts");
    const iatas = [
      ...new Set(
        view.members
          .filter((m) => !option || flyers.has(m.personId))
          .map((m) => (m.profile.homeCity ? resolveHome(m.profile.homeCity.value)?.iata : undefined))
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    const flights = iatas.slice(0, 3).map((o) => `✈️ from ${o.toLowerCase()}: ${googleFlightsLink(o, dest.iata, start, end)}`);
    say(tc, [`ready to book? links 👇`, ...flights, `🏠 stays: ${googleHotelsLink(dest.name, start, end, Math.min(tc.members.length, 4))}`].join("\n"));
  }
  await fireTripLocked(tc.trip, tc);
}

// ---------- tools ----------

const proposeTool: Tool = {
  decl: {
    name: "propose_destinations",
    description:
      "Find three destinations that fit everyone's hard constraints (dates, diets, budgets, vetoes, travel limits) and preferences, price them (live fares when available, otherwise labeled estimates), and post them with a poll. Posts its own messages.",
    parameters: {
      type: "object",
      properties: {
        nights: { type: "integer", description: "trip length if the group said one" },
        tier: { type: "string", enum: ["budget", "mid"] },
        exclude: { type: "array", items: { type: "string" }, description: "places to leave out (already rejected)" },
      },
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const r = await proposeDestinations(tc, { nights: num(args.nights), tier: args.tier === "budget" || args.tier === "mid" ? args.tier : undefined, exclude: Array.isArray(args.exclude) ? (args.exclude as string[]) : [] });
    return { ok: true, data: { options: r.options.map((o) => ({ name: o.name, perPerson: formatUsd(o.avgCents), live: o.live })), why: r.why }, next: "options and a poll were posted; at most a one-line lead-in, or NO_REPLY" };
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
    const poll = (await openPolls(tc.chat.id)).find((p) => p.kind === "destination");
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
    description: "Lock in a destination when the group (\"we\", \"everyone\", a majority) has clearly decided, even outside the poll. Posts the lock-in, rough plan and booking links itself.",
    parameters: { type: "object", properties: { destination: { type: "string", description: "option number or place name" } }, required: ["destination"] },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const input = str(args.destination) ?? "";
    const poll = (await openPolls(tc.chat.id)).find((p) => p.kind === "destination");
    let dest: Destination | undefined;
    if (/^\d+$/.test(input) && poll) dest = destinationById(String(poll.options[Number(input) - 1]?.ref ?? ""));
    dest ??= findDestination(input);
    if (!dest) throw new ToolError(`"${input}" isn't a place i have data for`);
    await lockDestination(tc, dest, `🎉 ${dest.name.toLowerCase()} it is!`);
    return { ok: true, next: "locked; the lock-in message and plan were posted" };
  },
};

export const proposalsFeature: Feature = {
  name: "proposals",
  tools: [proposeTool, recordVoteTool, lockTool],

  async fastPath(msg, tc) {
    if (msg.person_id === null) return false;
    const polls = await openPolls(tc.chat.id);
    if (polls.length === 0) return false;

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
      const poll = polls.find((p) => p.kind === "destination") ?? polls[0]!;
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
    for (const p of await openPolls(tc.chat.id)) {
      const hours = (tc.now.getTime() - p.created_at.getTime()) / 3_600_000;
      const votes = await votesFor(p.id);
      const voters = new Set(votes.filter((v) => v.selected).map((v) => v.personId)).size;
      if (hours > 6 && voters * 2 <= tc.members.length) out.push(`the "${p.title}" poll has been open ${Math.round(hours)}h with only ${voters} of ${tc.members.length} votes — the decision is stuck`);
    }
    return out;
  },

  async situation(tc) {
    const lines: string[] = [];
    for (const p of await openPolls(tc.chat.id)) {
      const votes = await votesFor(p.id);
      const by = (i: number) => votes.filter((v) => v.optionIdx === i && v.selected).map((v) => tc.label(v.personId));
      lines.push(`open poll "${p.title}" (${p.rendered_as}): ${p.options.map((o, i) => `${i + 1}. ${o.title} [${by(i).join(", ") || "no votes"}]`).join("; ")}`);
    }
    const row = await one<{ options: StoredOption[]; created_at: Date }>(`SELECT options, created_at FROM proposals WHERE trip_id = $1 ORDER BY id DESC LIMIT 1`, [tc.trip.id]);
    if (row) lines.push(`last proposal: ${row.options.map((o) => `${o.name} ~${formatUsd(o.avgCents)}pp${o.live ? " (live fares)" : " (est.)"}`).join(", ")}`);
    return lines.length ? { title: "proposals and polls", lines } : null;
  },

  async summary(tc) {
    const out: string[] = [];
    for (const p of await openPolls(tc.chat.id)) {
      const votes = await votesFor(p.id);
      out.push(`poll open: ${p.options.map((o, i) => `${o.title.split(" (")[0]} ${votes.filter((v) => v.optionIdx === i && v.selected).length}`).join(", ")}`);
    }
    return out;
  },
};
