// Weather watch: once a trip is locked, a recurring job reads the forecast for every trip day
// (operator overrides first, then Open-Meteo), keeps a snapshot per day, and when a day changes
// in a way that matters posts one heads-up, with a swap poll when an outdoor plan is at risk.
// Deterministic end to end: no model decides anything here. The agent only gets a tool for
// free-text answers to the swap ("yeah swap it") and a forecast section in its situation.
import { addDays, isoDate, now } from "../../clock.ts";
import { childLog } from "../../log.ts";
import { one, q, tx } from "../../db/pool.ts";
import { activeMembers, getChat, labelOf } from "../../db/repos/core.ts";
import { enqueueJob, rescheduleSingleton, type JobHandler } from "../../pipeline/jobs.ts";
import { groupView, interestWeights } from "../../profile/groupView.ts";
import { profilesFor } from "../../profile/store.ts";
import { destinationById, normalizeTag } from "../../trips/catalog.ts";
import { closePoll, createPoll, type PollRow } from "../../trips/pollStore.ts";
import { requestAnnounce } from "../../site/publish.ts";
import { announceSection } from "./site.ts";
import { updateTrip, type ItineraryDay, type TripRow, type TripStatus } from "../../trips/state.ts";
import type { Action } from "../../transport/outbound.ts";
import { nextCheckAt, shouldAlert, type AlertRecord } from "../../weather/cadence.ts";
import { describe as describeWeather, isWet, type WeatherCategory } from "../../weather/classify.ts";
import { detectChanges, toSnapshot, weekdayName, type Change, type DaySnapshot } from "../../weather/diff.ts";
import { fetchDailyForecast, FORECAST_DAYS, type DailyForecast } from "../../weather/openMeteo.ts";
import { COMFORT_HIGH_F, COMFORT_LOW_F, proposeSwap, type SpareActivity, type SwapProposal } from "../../weather/swaps.ts";
import type { AppServices, Feature, Section, TurnCtx } from "../feature.ts";
import type { Figure } from "../figures.ts";
import { ToolError, say, type Tool } from "../tools.ts";

export const WEATHER_JOB = "weather.check";
export const WEATHER_POLL_KIND = "weather_swap";
const WATCHED: readonly TripStatus[] = ["locked", "ongoing"];

export const weatherJobKey = (tripId: number): string => `weather:${tripId}`;

// ---------- network seam ----------

let weatherFetch: typeof fetch | undefined;

/** Tests inject a fake fetch; undefined restores the global one. */
export function setWeatherFetch(f: typeof fetch | undefined): void {
  weatherFetch = f;
}

export function currentWeatherFetch(): typeof fetch {
  return weatherFetch ?? ((input, init) => globalThis.fetch(input, init));
}

// ---------- trip helpers ----------

export function tripCoords(trip: TripRow): { lat: number; lon: number } | null {
  if (trip.latitude !== null && trip.longitude !== null) return { lat: trip.latitude, lon: trip.longitude };
  const dest = trip.destination_id ? destinationById(trip.destination_id) : undefined;
  return dest ? { lat: dest.lat, lon: dest.lon } : null;
}

/** Every calendar day of the trip, start to end inclusive. */
export function tripDays(trip: Pick<TripRow, "start_date" | "end_date">): string[] {
  if (!trip.start_date || !trip.end_date) return [];
  const days: string[] = [];
  for (let d = trip.start_date; d <= trip.end_date && days.length < 60; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Start (or re-start) the watch: a weather.check due now. True when the trip can be watched. */
export async function startWeatherWatch(trip: TripRow): Promise<boolean> {
  if (!trip.start_date || !trip.end_date || !tripCoords(trip)) return false;
  const key = weatherJobKey(trip.id);
  const at = now();
  const id = await enqueueJob(WEATHER_JOB, { tripId: trip.id, chatId: trip.chat_id }, { singletonKey: key, dueAt: at });
  // Already watching (e.g. re-locked with new dates): pull the next check forward to now.
  if (id === undefined) await rescheduleSingleton(key, at);
  return true;
}

// ---------- forecast assembly ----------

export interface DayForecast {
  forecast: DailyForecast;
  source: "override" | "open-meteo";
}

function asForecast(day: string, raw: unknown): DailyForecast | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const code = n(r.weatherCode);
  if (code === null) return null;
  return { day, weatherCode: code, precipProbability: n(r.precipProbability), tempMaxF: n(r.tempMaxF), tempMinF: n(r.tempMinF), windGustMph: n(r.windGustMph) };
}

/**
 * The forecast for each remaining trip day: an operator override wins, otherwise Open-Meteo.
 * Days outside the 16-day window are absent. The network is only touched when a day that can
 * have a forecast isn't overridden; a failed fetch throws (the job runner retries with backoff).
 */
export async function tripForecast(trip: TripRow, today: string): Promise<Map<string, DayForecast>> {
  const days = tripDays(trip).filter((d) => d >= today);
  const out = new Map<string, DayForecast>();
  if (days.length === 0) return out;
  const rows = await q<{ day: string; forecast: unknown }>(`SELECT day, forecast FROM weather_overrides WHERE trip_id = $1 AND day BETWEEN $2 AND $3`, [
    trip.id,
    days[0],
    days[days.length - 1],
  ]);
  const overrides = new Map<string, DailyForecast>();
  for (const r of rows) {
    const f = asForecast(r.day, r.forecast);
    if (f) overrides.set(r.day, f);
  }
  const horizon = addDays(today, FORECAST_DAYS - 1);
  const coords = tripCoords(trip);
  const fetched = new Map<string, DailyForecast>();
  if (coords && days.some((d) => !overrides.has(d) && d <= horizon)) {
    for (const f of await fetchDailyForecast(coords.lat, coords.lon, { fetch: currentWeatherFetch() })) fetched.set(f.day, f);
  }
  for (const d of days) {
    const o = overrides.get(d);
    const f = fetched.get(d);
    if (o) out.set(d, { forecast: o, source: "override" });
    else if (f) out.set(d, { forecast: f, source: "open-meteo" });
  }
  return out;
}

interface SnapshotRow {
  day: string;
  weather_code: number;
  category: WeatherCategory;
  precip_probability: number | null;
  temp_max_f: number | null;
  temp_min_f: number | null;
  wind_gust_mph: number | null;
  source: string;
  fetched_at: Date;
}

/** The latest stored snapshot per trip day (optionally only days from `fromDay` on). */
export async function latestSnapshots(tripId: number, fromDay?: string): Promise<SnapshotRow[]> {
  return q<SnapshotRow>(
    `SELECT DISTINCT ON (day) day, weather_code, category, precip_probability, temp_max_f, temp_min_f, wind_gust_mph, source, fetched_at
       FROM weather_snapshots WHERE trip_id = $1 AND ($2::date IS NULL OR day >= $2::date)
      ORDER BY day, fetched_at DESC`,
    [tripId, fromDay ?? null],
  );
}

function rowSnapshot(r: SnapshotRow): DaySnapshot {
  return { day: r.day, category: r.category, precipProbability: r.precip_probability, tempMaxF: r.temp_max_f, windGustMph: r.wind_gust_mph };
}

async function alertHistory(tripId: number): Promise<AlertRecord[]> {
  const rows = await q<{ day: string; kind: string; sent_at: Date }>(`SELECT day, kind, sent_at FROM weather_alerts WHERE trip_id = $1 ORDER BY sent_at`, [tripId]);
  return rows.map((r) => ({ day: r.day, kind: r.kind, sentAt: r.sent_at }));
}

// ---------- deciding what to say ----------

/** Wet/stormy/windy days always matter; a temp swing only outside the comfort band; "cleared up" only after we warned about that day. */
function worthMentioning(change: Change, history: AlertRecord[]): boolean {
  switch (change.kind) {
    case "turned_wet":
    case "storm":
    case "wind":
      return true;
    case "temp_swing": {
      const t = change.to.tempMaxF;
      return t !== null && (t < COMFORT_LOW_F || t >= COMFORT_HIGH_F);
    }
    case "cleared_up":
      return history.some((h) => h.day === change.day && (h.kind === "turned_wet" || h.kind === "storm"));
  }
}

const lc = (s: string): string => s.trim().toLowerCase();
const the = (name: string): string => (/^(the|a|an) /.test(lc(name)) ? lc(name) : `the ${lc(name)}`);

function hasOutdoor(itinerary: ItineraryDay[], day: string): boolean {
  return itinerary.some((d) => d.date === day && d.items.some((i) => i.setting === "outdoor"));
}

/** The line for a change with no swap to offer. */
export function headsUp(change: Change, itinerary: ItineraryDay[]): string {
  if (change.kind === "cleared_up") return `good news: ${change.summary}`;
  const items = itinerary.find((d) => d.date === change.day)?.items ?? [];
  const outdoor = items.find((i) => i.setting === "outdoor");
  if (items.length === 0) return `heads up: ${change.summary}. nothing's planned that day yet`;
  if (!outdoor) return `heads up: ${change.summary} — the plan's all indoor that day so we're fine`;
  return `heads up: ${change.summary}, which could mess with ${the(outdoor.name)}. i don't see an easy indoor swap, so maybe have a backup`;
}

function spareActivities(trip: TripRow): SpareActivity[] {
  const dest = trip.destination_id ? destinationById(trip.destination_id) : undefined;
  if (!dest) return [];
  const planned = new Set(trip.itinerary.flatMap((d) => d.items.map((i) => i.activityId)));
  return dest.activities.filter((a) => !planned.has(a.id)).map((a) => ({ id: a.id, name: a.name, setting: a.setting, costCents: a.costCents, tags: [...a.tags] }));
}

/** Group interest weights keyed by catalog tag ("museums" → culture). */
async function groupInterests(chatId: number, today: string): Promise<Record<string, number>> {
  const members = await activeMembers(chatId);
  if (members.length === 0) return {};
  const profiles = await profilesFor(members.map((m) => m.id));
  const view = groupView(
    members.map((m) => ({ personId: m.id, label: labelOf(m), profile: profiles.get(m.id)! })),
    today,
  );
  const out: Record<string, number> = {};
  for (const [key, w] of Object.entries(interestWeights(view))) {
    const tag = normalizeTag(key) ?? key.toLowerCase();
    out[tag] = Math.max(out[tag] ?? Number.NEGATIVE_INFINITY, w);
  }
  return out;
}

interface SwapRef {
  apply: boolean;
  proposal: SwapProposal;
}

function swapRef(ref: unknown): SwapRef | null {
  if (!ref || typeof ref !== "object") return null;
  const r = ref as { apply?: unknown; proposal?: unknown };
  const p = r.proposal as Partial<SwapProposal> | undefined;
  if (typeof r.apply !== "boolean" || !p || typeof p.day !== "string" || (p.kind !== "swap_days" && p.kind !== "replace") || !p.outdoor || !p.replacement) return null;
  return { apply: r.apply, proposal: p as SwapProposal };
}

async function openSwapPoll(chatId: number, tripId?: number): Promise<PollRow | undefined> {
  return one<PollRow>(
    `SELECT * FROM polls WHERE chat_id = $1 AND kind = $2 AND status = 'open' AND ($3::bigint IS NULL OR trip_id = $3) ORDER BY id DESC LIMIT 1`,
    [chatId, WEATHER_POLL_KIND, tripId ?? null],
  );
}

function pollProposal(poll: PollRow): SwapProposal | null {
  for (const o of poll.options) {
    const ref = swapRef(o.ref);
    if (ref) return ref.proposal;
  }
  return null;
}

// ---------- the check ----------

export interface CheckResult {
  /** Snapshots stored this check. */
  stored: number;
  changes: Change[];
  /** Changes announced (the lead one first). */
  announced: Change[];
  message: string | null;
  pollId: number | null;
}

/** One forecast check for a trip: fetch, diff against the last snapshot, maybe post, store. */
export async function checkTripWeather(
  svc: Pick<AppServices, "post">,
  trip: TripRow,
  opts: { today: string; guidPrefix: string },
): Promise<CheckResult> {
  const log = childLog({ component: "weather", tripId: trip.id, chatId: trip.chat_id });
  const t = now();
  const fresh = await tripForecast(trip, opts.today);
  const prev = new Map((await latestSnapshots(trip.id)).map((r) => [r.day, rowSnapshot(r)]));
  const next = new Map([...fresh].map(([day, f]) => [day, toSnapshot(f.forecast)]));
  const history = await alertHistory(trip.id);
  const changes = detectChanges(prev, next);
  const alertable = changes.filter((c) => worthMentioning(c, history) && shouldAlert(c, history, t));
  // At most one lead change per check: the most severe, then the earliest day.
  const lead = [...alertable].sort((a, b) => b.severity - a.severity || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))[0];

  const result: CheckResult = { stored: fresh.size, changes, announced: [], message: null, pollId: null };
  if (lead) {
    const itinerary = trip.itinerary ?? [];
    const proposal =
      lead.kind === "cleared_up"
        ? null
        : proposeSwap({
            change: lead,
            itinerary,
            spareActivities: spareActivities(trip),
            interests: await groupInterests(trip.chat_id, opts.today),
            forecastByDay: next,
            today: opts.today,
          });
    let message = proposal ? proposal.message : headsUp(lead, itinerary);
    if (lead.kind === "cleared_up") {
      const open = await openSwapPoll(trip.chat_id, trip.id);
      if (open && pollProposal(open)?.day === lead.day) {
        await closePoll(open.id, null, t);
        message += ", so no need to swap";
      }
    }
    // Other days that just turned bad for an outdoor plan ride along in the same bubble.
    const seen = new Set([lead.day]);
    const extras: Change[] = [];
    for (const c of alertable) {
      if (seen.has(c.day) || c.severity < 2 || !hasOutdoor(itinerary, c.day)) continue;
      seen.add(c.day);
      extras.push(c);
    }
    if (extras.length) message += `\nalso: ${extras.map((c) => c.summary).join("; ")}`;

    const actions: Action[] = [{ type: "say", text: message }];
    if (proposal) {
      const title = `swap ${weekdayName(proposal.day)}'s plan?`;
      const poll = await createPoll({
        tripId: trip.id,
        chatId: trip.chat_id,
        kind: WEATHER_POLL_KIND,
        title,
        options: proposal.pollOptions.map((o, i) => ({ title: o, ref: { apply: i === 0, proposal } })),
        at: t,
      });
      actions.push({ type: "poll", title, options: [...proposal.pollOptions], pollId: poll.id });
      result.pollId = poll.id;
    }
    // Post before storing: if posting fails the retry still sees the change and tries again.
    await svc.post(trip.chat_id, `${opts.guidPrefix}-${lead.day}-${t.getTime()}`, actions);
    result.announced = [lead, ...extras];
    result.message = message;
    log.info({ day: lead.day, kind: lead.kind, swap: proposal?.kind ?? null }, "weather alert sent");
  }

  await tx(async (c) => {
    for (const [day, { forecast: f, source }] of fresh) {
      const s = toSnapshot(f);
      await c.query(
        `INSERT INTO weather_snapshots (fetched_at, trip_id, day, weather_code, category, precip_probability, temp_max_f, temp_min_f, wind_gust_mph, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (trip_id, day, fetched_at) DO UPDATE SET weather_code = EXCLUDED.weather_code, category = EXCLUDED.category,
           precip_probability = EXCLUDED.precip_probability, temp_max_f = EXCLUDED.temp_max_f, temp_min_f = EXCLUDED.temp_min_f,
           wind_gust_mph = EXCLUDED.wind_gust_mph, source = EXCLUDED.source`,
        [t, trip.id, day, Math.round(f.weatherCode), s.category, f.precipProbability === null ? null : Math.round(f.precipProbability), f.tempMaxF, f.tempMinF, f.windGustMph, source],
      );
    }
    for (const ch of result.announced) {
      await c.query(`INSERT INTO weather_alerts (trip_id, day, kind, message, sent_at) VALUES ($1,$2,$3,$4,$5)`, [trip.id, ch.day, ch.kind, result.message, t]);
    }
  });
  return result;
}

function weatherCheckJob(svc: AppServices): JobHandler {
  return async (payload, { jobId, attempt }) => {
    const trip = await one<TripRow>(`SELECT * FROM trips WHERE id = $1`, [Number(payload.tripId)]);
    if (!trip || !WATCHED.includes(trip.status) || !trip.start_date || !trip.end_date) return;
    const chat = await getChat(trip.chat_id);
    if (!chat) return;
    const timeZone = chat.timezone;
    const today = isoDate(now(), timeZone);
    if (today > trip.end_date) return;
    await checkTripWeather(svc, trip, { today, guidPrefix: `wx${jobId}-${attempt}` });
    const next = nextCheckAt(now(), { start: trip.start_date, end: trip.end_date, timeZone });
    return next ? { rescheduleAt: next } : undefined;
  };
}

// ---------- applying a swap ----------

export type ApplyStatus = "applied" | "already" | "stale";

/** The itinerary with the proposal applied; "already" if it was, "stale" if the plan moved on since. */
export function applySwap(itinerary: ItineraryDay[], p: SwapProposal, destinationId?: string | null): { status: ApplyStatus; itinerary: ItineraryDay[] } {
  const days = itinerary.map((d) => ({ ...d, items: [...d.items] }));
  const target = days.find((d) => d.date === p.day);
  if (!target) return { status: "stale", itinerary };
  const oi = target.items.findIndex((i) => i.activityId === p.outdoor.activityId);

  if (p.kind === "swap_days") {
    const from = days.find((d) => d.date === p.replacement.fromDay);
    if (!from) return { status: "stale", itinerary };
    const ri = from.items.findIndex((i) => i.activityId === p.replacement.activityId);
    if (oi < 0 || ri < 0) {
      const done = target.items.some((i) => i.activityId === p.replacement.activityId) && from.items.some((i) => i.activityId === p.outdoor.activityId);
      return { status: done ? "already" : "stale", itinerary };
    }
    const outdoor = target.items[oi]!;
    target.items[oi] = from.items[ri]!;
    from.items[ri] = outdoor;
    return { status: "applied", itinerary: days };
  }

  if (oi < 0) return { status: target.items.some((i) => i.activityId === p.replacement.activityId) ? "already" : "stale", itinerary };
  const act = destinationId ? destinationById(destinationId)?.activities.find((a) => a.id === p.replacement.activityId) : undefined;
  const item = act
    ? { activityId: act.id, name: act.name, setting: act.setting, costCents: act.costCents, tags: [...act.tags], durationHours: act.durationHours }
    : { activityId: p.replacement.activityId, name: p.replacement.name, setting: "indoor" as const, costCents: p.replacement.costCents };
  target.items[oi] = item;
  return { status: "applied", itinerary: days };
}

export function swapConfirmation(p: SwapProposal): string {
  if (p.kind === "swap_days") return `done: ${lc(p.replacement.name)} moved to ${weekdayName(p.day)}, ${lc(p.outdoor.name)} to ${weekdayName(p.replacement.fromDay ?? p.day)}`;
  return `done: ${lc(p.replacement.name)} instead of ${the(p.outdoor.name)} on ${weekdayName(p.day)}`;
}

/** Carry out a decided weather_swap poll; posts the confirmation into tc.out. */
async function decideSwap(poll: PollRow, winnerIdx: number, tc: TurnCtx): Promise<{ applied: boolean; posted: string[] }> {
  const ref = swapRef(poll.options[winnerIdx]?.ref);
  if (!ref || !ref.apply) return { applied: false, posted: say(tc, "keeping the plan as is") };
  const trip = (await one<TripRow>(`SELECT * FROM trips WHERE id = $1`, [poll.trip_id])) ?? tc.trip;
  const result = applySwap(trip.itinerary, ref.proposal, trip.destination_id);
  if (result.status === "already") return { applied: true, posted: [] };
  if (result.status === "stale") return { applied: false, posted: say(tc, "the plan changed since i suggested that, so i left it as is") };
  const updated = await updateTrip(trip.id, { itinerary: result.itinerary });
  const posted = say(tc, swapConfirmation(ref.proposal));
  if (tc.trip.id === updated.id) {
    tc.trip = updated;
    await announceSection(tc, "itinerary");
  } else await requestAnnounce(tc.cfg, updated, "itinerary");
  return { applied: true, posted };
}

const applyWeatherSwap: Tool = {
  decl: {
    name: "apply_weather_swap",
    description:
      "Answer the open weather swap poll when someone replies in words instead of voting (\"yeah swap it\" → apply true, \"nah keep the plan\" → apply false). Updates the itinerary, closes the poll and posts the confirmation itself.",
    parameters: {
      type: "object",
      properties: { apply: { type: "boolean", description: "true to make the swap, false to keep the plan" } },
      required: ["apply"],
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const apply = args.apply === true || args.apply === "true";
    const poll = await openSwapPoll(tc.chat.id);
    if (!poll) throw new ToolError("there's no open weather swap right now");
    let idx = poll.options.findIndex((o) => swapRef(o.ref)?.apply === apply);
    if (idx < 0) idx = apply ? 0 : poll.options.length - 1;
    await closePoll(poll.id, idx, tc.now);
    const { applied, posted } = await decideSwap(poll, idx, tc);
    return { ok: true, posted, data: { applied }, next: "the confirmation is already posted; don't repeat it" };
  },
};

// ---------- what the agent and summaries see ----------

const WEEK_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MONTH_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/** "2026-10-17" → "sat oct 17". */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return `${WEEK_SHORT[d.getUTCDay()]} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "rain 70%, 64°" / "sunny, 78°". */
function weatherWords(r: SnapshotRow): string {
  const word = describeWeather(r.category, null);
  const pct = isWet(r.category) && r.precip_probability !== null ? ` ${r.precip_probability}%` : "";
  const temp = r.temp_max_f !== null ? `, ${Math.round(r.temp_max_f)}°` : "";
  return `${word}${pct}${temp}`;
}

/** "sat rain 70%" / "fri sunny 78°". */
function compactWeather(r: SnapshotRow): string {
  const wd = WEEK_SHORT[new Date(`${r.day}T12:00:00Z`).getUTCDay()];
  const word = describeWeather(r.category, null);
  if (isWet(r.category) && r.precip_probability !== null) return `${wd} ${word} ${r.precip_probability}%`;
  return `${wd} ${word}${r.temp_max_f !== null ? ` ${Math.round(r.temp_max_f)}°` : ""}`;
}

async function tripSnapshots(trip: TripRow, today: string): Promise<SnapshotRow[]> {
  if (!WATCHED.includes(trip.status) || !trip.start_date || !trip.end_date) return [];
  const rows = await latestSnapshots(trip.id, today > trip.start_date ? today : trip.start_date);
  return rows.filter((r) => r.day <= trip.end_date!);
}

export const weatherFeature: Feature = {
  name: "weather",
  tools: [applyWeatherSwap],

  async onTripLocked(trip) {
    await startWeatherWatch(trip);
  },

  jobs(svc) {
    return { [WEATHER_JOB]: weatherCheckJob(svc) };
  },

  async onPollDecided(poll, winnerIdx, tc) {
    if (poll.kind !== WEATHER_POLL_KIND) return false;
    await q(`UPDATE polls SET status = 'closed', winner_idx = $2, closed_at = $3 WHERE id = $1 AND status = 'open'`, [poll.id, winnerIdx, tc.now]);
    await decideSwap(poll, winnerIdx, tc);
    return true;
  },

  async figures(tc) {
    const poll = await openSwapPoll(tc.chat.id);
    const p = poll ? pollProposal(poll) : null;
    if (!p || p.kind !== "replace") return [];
    const delta = Math.abs(p.replacement.costCents - p.outdoor.costCents);
    const fig: Figure = { cents: delta, label: `price difference, ${lc(p.replacement.name)} vs ${lc(p.outdoor.name)}`, source: "estimate:weather_swap", visibility: "public" };
    return delta > 0 ? [fig] : [];
  },

  async situation(tc): Promise<Section | null> {
    const rows = await tripSnapshots(tc.trip, tc.today);
    const lines = rows.map((r) => `${dayLabel(r.day)}: ${weatherWords(r)}${r.source === "override" ? " (injected for rehearsal)" : ""}`);
    const poll = WATCHED.includes(tc.trip.status) ? await openSwapPoll(tc.chat.id) : undefined;
    const p = poll ? pollProposal(poll) : null;
    if (poll && p) {
      lines.push(
        `open weather swap poll "${poll.title}" (${poll.options.map((o) => o.title).join(" / ")}): ${p.message}. if someone answers it in words, call apply_weather_swap`,
      );
    }
    return lines.length ? { title: "forecast", lines } : null;
  },

  async summary(tc) {
    const rows = await tripSnapshots(tc.trip, tc.today);
    return rows.length ? [`forecast: ${rows.map(compactWeather).join(", ")}`] : [];
  },
};
