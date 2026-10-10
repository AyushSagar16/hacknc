// Destination proposals and decisions. Hard constraints filter the catalog, soft preferences
// score it, the top candidates get live prices (SerpApi Google Flights/Hotels, cached) with
// labeled estimates as fallback, and three options go out with per-person cost breakdowns and
// a poll. Votes arrive as native poll votes, tapbacks on an option bubble, or plain text ("2",
// "lisbon"); a majority of the group (or everyone voting) decides and locks the trip in.
import { config } from "../../config.ts";
import { now } from "../../clock.ts";
import { formatUsd } from "../../money/cents.ts";
import { one, q } from "../../db/pool.ts";
import type { MessageRow } from "../../db/repos/core.ts";
import { budgetRows } from "../../nessie/budgets.ts";
import { interestWeights } from "../../profile/groupView.ts";
import { destinationById, destinations, findDestination, type Destination } from "../../trips/catalog.ts";
import { buildConstraints } from "../../trips/constraints.ts";
import { hardFilter, type Rejection } from "../../trips/filter.ts";
import type { CostBreakdown } from "../../trips/estimate.ts";
import { draftItinerary } from "../../trips/itinerary.ts";
import { googleFlightsLink, googleHotelsLink } from "../../trips/links.ts";
import { closePoll, createPoll, openPolls, recordVote, votesFor, type PollRow } from "../../trips/pollStore.ts";
import { priceOption, type PriceCache } from "../../trips/pricing.ts";
import { pickThree, scoreDestinations, type Scored } from "../../trips/score.ts";
import { updateTrip } from "../../trips/state.ts";
import { parseVote, tally } from "../../trips/votes.ts";
import { formatRange } from "./planning.ts";
import { fireTripLocked, type Feature, type TurnCtx } from "../feature.ts";
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
const component = (c: CostBreakdown, k: "transport" | "lodging") => (c.sources[k].kind === "live" ? "live fare" : "est.");

function optionLine(i: number, o: StoredOption): string {
  const sample = Object.values(o.perPerson)[0]!;
  const spread = o.maxCents - o.minCents > 2_500 ? ` (${formatUsd(o.minCents)}–${formatUsd(o.maxCents)} depending on where you leave from)` : "";
  const parts = [
    `${sample.transportMode === "drive" ? "gas" : "flight"} ${formatUsd(avg(Object.values(o.perPerson).map((c) => c.transportCents)))} ${component(sample, "transport")}`,
    `stay ${formatUsd(avg(Object.values(o.perPerson).map((c) => c.lodgingCents)))} ${component(sample, "lodging")}`,
    `food + activities ${formatUsd(avg(Object.values(o.perPerson).map((c) => c.foodCents + c.activitiesCents + c.localCents)))} est.`,
  ];
  const why = o.reasons.length ? `\n${o.reasons.slice(0, 2).join(", ").toLowerCase()}` : "";
  return `${i + 1}. ${o.name}: ~${formatUsd(o.avgCents)} per person${spread}\n${parts.join(" · ")}${why}`;
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

function explainRejections(rejected: Rejection[], tc: TurnCtx): string {
  const counts = new Map<string, number>();
  for (const r of rejected) {
    const key = r.reason.replace(/^.*?(over .*?'s ceiling).*$/, "$1 budget").replace(/by ~\$[\d,]+/, "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r]) => r);
  void tc;
  return top.join("; ");
}

/** Build, price and post three options with a poll. Returns what happened for the model. */
export async function proposeDestinations(tc: TurnCtx, opts: { nights?: number; tier?: "budget" | "mid"; exclude?: string[] } = {}): Promise<{ posted: boolean; options: StoredOption[]; why?: string }> {
  const view = await tc.view();
  const budgets = await budgetRows(tc.trip.id);
  const built = buildConstraints(view, budgets, { tripStart: tc.trip.start_date, tripEnd: tc.trip.end_date, nights: opts.nights, tier: opts.tier });
  const catalog = destinations().filter((d) => !(opts.exclude ?? []).some((x) => findDestination(x)?.id === d.id));
  const { passed, rejected } = hardFilter(catalog, built.group);
  if (passed.length === 0) {
    const why = explainRejections(rejected, tc);
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
  say(tc, `three options for ${when}, per person${anyLive ? " (live fares where marked, the rest are estimates)" : " (estimates)"}:`);
  for (const [i, o] of options.entries()) say(tc, optionLine(i, o));
  tc.out.push({ type: "poll", title: "where to? vote below", options: poll.options.map((o) => o.title), pollId: poll.id });
  return { posted: true, options };
}

// ---------- votes ----------

function optionIndexFor(poll: PollRow, title: string): number {
  const t = title.trim().toLowerCase();
  const exact = poll.options.findIndex((o) => o.title.toLowerCase() === t);
  if (exact >= 0) return exact;
  return poll.options.findIndex((o) => t.startsWith(o.title.toLowerCase().split(" (")[0]!));
}

async function afterVote(poll: PollRow, tc: TurnCtx, voterId: number, source: "native" | "tapback" | "text" | "agent", msg: MessageRow | null): Promise<void> {
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
    return;
  }
  // Not decided yet: acknowledge text votes with a tapback (others already show on the poll).
  if (source === "text" && msg) {
    const choice = poll.options[votes.filter((v) => v.personId === voterId && v.selected).at(-1)?.optionIdx ?? 0]?.title.split(" (")[0] ?? "";
    tc.out.push({ type: "react", targetId: msg.provider_message_id, tapback: "like", fallbackText: `got it: ${tc.label(voterId).toLowerCase()} → ${choice.toLowerCase()} (${result.voters} of ${tc.members.length} voted)` });
  }
}

async function lockFromPoll(poll: PollRow, winner: number, count: number, tc: TurnCtx): Promise<boolean> {
  const destId = String(poll.options[winner]?.ref ?? "");
  const dest = destinationById(destId);
  if (!dest) return false;
  await lockDestination(tc, dest, `${dest.name.toLowerCase()} wins (${count} of ${tc.members.length})`);
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
  const when = start && end ? `locked in for ${formatRange(start, end)} 🎉` : "locked in. now we just need dates";
  say(tc, `${headline}. ${dest.name.toLowerCase()} is ${when}`);
  if (itinerary.length) {
    say(tc, `rough plan:\n${itinerary.map((d) => `${new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }).toLowerCase()}: ${d.items.map((i) => i.name.toLowerCase()).join(", ") || "free day"}`).join("\n")}`);
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
    const flights = iatas.slice(0, 3).map((o) => `flights from ${o}: ${googleFlightsLink(o, dest.iata, start, end)}`);
    say(tc, [`to book:`, ...flights, `stays: ${googleHotelsLink(dest.name, start, end, Math.min(tc.members.length, 4))}`].join("\n"));
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
    await lockDestination(tc, dest, `going with ${dest.name.toLowerCase()}`);
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
      const poll = polls.find((p) => p.provider_poll_id && p.provider_poll_id === pollMessageId) ?? polls.find((p) => p.rendered_as === "native" && optionIndexFor(p, String(msg.meta.optionTitle)) >= 0);
      if (!poll) return false;
      const idx = optionIndexFor(poll, String(msg.meta.optionTitle));
      if (idx < 0) return false;
      await recordVote(poll.id, msg.person_id, idx, msg.meta.selected !== false, "native", tc.now);
      await afterVote(poll, tc, msg.person_id, "native", msg);
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
      if (idx === null) return false;
      await recordVote(poll.id, msg.person_id, idx, true, "text", tc.now, { single: true });
      await afterVote(poll, tc, msg.person_id, "text", msg);
      return true;
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
