// The weather watch end to end on the simulator: a locked trip, a recurring forecast check
// against a fake Open-Meteo, one swap offer when the beach day turns wet, no repeats, the swap
// applied by tool or by poll decision, operator overrides without network, and retries.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixedClock, setClock, systemClock } from "../../src/clock.ts";
import { q } from "../../src/db/pool.ts";
import { findChat, type ChatRow } from "../../src/db/repos/core.ts";
import { callResult, textResult } from "../../src/agent/llm.ts";
import type { TurnCtx } from "../../src/agent/feature.ts";
import { applySwap, setWeatherFetch, weatherFeature } from "../../src/agent/features/weather.ts";
import type { PollRow } from "../../src/trips/pollStore.ts";
import { tripFor, updateTrip, type ItineraryDay, type TripRow } from "../../src/trips/state.ts";
import type { SwapProposal } from "../../src/weather/swaps.ts";
import type { ScenarioRunner } from "../../src/sim/script.ts";
import type { SimSession } from "../../src/sim/session.ts";
import { weatherSimExtension } from "../../src/sim/weatherExtension.ts";
import type { SimChat } from "../../src/transport/sim/platform.ts";
import { dbAvailable } from "../helpers/db.ts";
import { quietFake, testAtlas, type TestAtlas } from "../helpers/atlas.ts";

const describeDb = dbAvailable ? describe : describe.skip;

const HOUR = 3_600_000;
/** 14:00 in Charleston, six days before the trip. */
const TODAY = new Date("2026-10-10T18:00:00Z");
const FRI = "2026-10-16";
const SAT = "2026-10-17";
const SUN = "2026-10-18";

const FOOD_TOUR = { activityId: "charleston-city-market-food-tour", name: "City Market & Lowcountry food tour", setting: "indoor" as const, costCents: 7500, tags: ["food", "culture", "walkable"] };
const BEACH = { activityId: "charleston-folly-beach", name: "Folly Beach day", setting: "outdoor" as const, costCents: 0, tags: ["beach", "relaxing"] };
const MUSEUM = { activityId: "charleston-gibbes-museum", name: "Gibbes Museum of Art", setting: "indoor" as const, costCents: 1500, tags: ["culture"] };
const ITINERARY: ItineraryDay[] = [
  { date: FRI, items: [FOOD_TOUR] },
  { date: SAT, items: [BEACH] },
  { date: SUN, items: [MUSEUM] },
];

// ---------- a fake Open-Meteo built from the captured Charleston forecast ----------

const FIXTURE = readFileSync(new URL("../fixtures/open-meteo/forecast-charleston.json", import.meta.url), "utf8");
type Edit = { code?: number; precip?: number; tmax?: number };

function forecastJson(edits: Record<string, Edit>): string {
  const body = JSON.parse(FIXTURE) as { daily: { time: string[]; weather_code: number[]; precipitation_probability_max: number[]; temperature_2m_max: number[] } };
  for (const [day, e] of Object.entries(edits)) {
    const i = body.daily.time.indexOf(day);
    if (i < 0) throw new Error(`fixture has no ${day}`);
    if (e.code !== undefined) body.daily.weather_code[i] = e.code;
    if (e.precip !== undefined) body.daily.precipitation_probability_max[i] = e.precip;
    if (e.tmax !== undefined) body.daily.temperature_2m_max[i] = e.tmax;
  }
  return JSON.stringify(body);
}

/** The fixture is dry on fri/sat/sun (cloudy, under 10% rain); edits flip days. */
function fakeOpenMeteo() {
  const state = { edits: {} as Record<string, Edit>, fail: false };
  const impl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    if (state.fail) throw new TypeError("fetch failed");
    return new Response(forecastJson(state.edits), { status: 200, headers: { "content-type": "application/json" } });
  });
  setWeatherFetch(impl as unknown as typeof fetch);
  return { state, impl };
}

// ---------- helpers ----------

/** Run only the weather job (other features' jobs, e.g. Nessie linking, are parked). */
async function runWeather(t: TestAtlas): Promise<void> {
  await q(`UPDATE jobs SET due_at = '2100-01-01' WHERE kind <> 'weather.check' AND done_at IS NULL AND failed_at IS NULL`);
  await t.app.jobs.runDue();
}

/** Move the clock and make the pending weather check due right then. */
async function checkAt(t: TestAtlas, clock: FixedClock, at: Date): Promise<void> {
  clock.set(at);
  await q(`UPDATE jobs SET due_at = $1 WHERE kind = 'weather.check' AND done_at IS NULL AND failed_at IS NULL`, [at]);
  await runWeather(t);
}

async function lockedTrip(t: TestAtlas, id: string): Promise<{ chat: SimChat; row: ChatRow; trip: TripRow }> {
  const chat = t.chat(id, ["maya", "leo", "priya"]);
  await chat.addAtlas();
  const row = (await findChat("sim", id))!;
  const trip = await updateTrip((await tripFor(row.id)).id, {
    status: "locked",
    destination_id: "charleston",
    destination_name: "Charleston",
    latitude: 32.7765,
    longitude: -79.9311,
    start_date: FRI,
    end_date: SUN,
    itinerary: ITINERARY,
    locked_at: TODAY,
  });
  await weatherFeature.onTripLocked!(trip, {} as TurnCtx);
  return { chat, row, trip };
}

async function weatherJob(): Promise<{ due_at: Date; done_at: Date | null; attempts: number; last_error: string | null }> {
  const rows = await q<{ due_at: Date; done_at: Date | null; attempts: number; last_error: string | null }>(
    `SELECT due_at, done_at, attempts, last_error FROM jobs WHERE kind = 'weather.check' ORDER BY id`,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const tripRow = async (id: number) => (await q<TripRow>(`SELECT * FROM trips WHERE id = $1`, [id]))[0]!;
const swapPolls = () => q<PollRow>(`SELECT * FROM polls WHERE kind = 'weather_swap' ORDER BY id`);
const alerts = () => q<{ day: string; kind: string }>(`SELECT day, kind FROM weather_alerts ORDER BY sent_at`);

function tcFor(chat: ChatRow, trip: TripRow, clock: FixedClock): TurnCtx {
  return { chat, trip, out: [], now: clock.now(), today: "2026-10-11", notes: new Map() } as unknown as TurnCtx;
}

const SWAP_MESSAGE = "saturday flipped to rain (70%). want to swap the folly beach day for the city market & lowcountry food tour on friday?";

describeDb("weather watch", () => {
  let t: TestAtlas | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    setWeatherFetch(undefined);
    setClock(systemClock);
  });

  it("checks quietly, offers one swap when the beach day turns wet, never repeats it, and applies it by tool", async () => {
    const clock = new FixedClock(TODAY);
    setClock(clock);
    const meteo = fakeOpenMeteo();
    let agentCalls = 0;
    const llm = quietFake().set("agent", () => (agentCalls++ === 0 ? callResult("apply_weather_swap", { apply: true }) : textResult("NO_REPLY")));
    t = await testAtlas({ llm, features: [weatherFeature] });
    const { chat, row, trip } = await lockedTrip(t, "wx1");

    // (a) first look, dry: nothing to say, a snapshot per trip day, next check per cadence (6 days out → 6 h).
    let mark = chat.lastEntry();
    await runWeather(t);
    expect(chat.atlasSince(mark)).toEqual([]);
    expect(meteo.impl).toHaveBeenCalledTimes(1);
    const url = new URL(String(meteo.impl.mock.calls[0]![0]));
    expect(url.searchParams.get("latitude")).toBe("32.7765");
    const snaps = await q<{ day: string; category: string; source: string }>(`SELECT day, category, source FROM weather_snapshots ORDER BY day`);
    expect(snaps).toEqual([
      { day: FRI, category: "cloudy", source: "open-meteo" },
      { day: SAT, category: "cloudy", source: "open-meteo" },
      { day: SUN, category: "cloudy", source: "open-meteo" },
    ]);
    let job = await weatherJob();
    expect(job.done_at).toBeNull();
    expect(job.due_at.toISOString()).toBe("2026-10-11T00:00:00.000Z");

    // (b) six hours later saturday flips to rain: one message with the swap, then a native poll.
    meteo.state.edits = { [SAT]: { code: 63, precip: 70 } };
    clock.advance(6 * HOUR);
    mark = chat.lastEntry();
    await runWeather(t);
    const posted = chat.atlasSince(mark);
    expect(posted.map((e) => e.kind)).toEqual(["text", "poll"]);
    expect(posted[0]!.text).toBe(SWAP_MESSAGE);
    expect(posted[1]!.poll).toEqual({ title: "swap saturday's plan?", options: ["swap them", "keep the plan"] });
    const [poll] = await swapPolls();
    expect(poll).toMatchObject({ status: "open", rendered_as: "native", title: "swap saturday's plan?" });
    expect(poll!.provider_poll_id).toBe(posted[1]!.id);
    expect(poll!.options.map((o) => (o.ref as { apply: boolean }).apply)).toEqual([true, false]);
    expect(await alerts()).toEqual([{ day: SAT, kind: "turned_wet" }]);
    expect((await weatherJob()).due_at.toISOString()).toBe("2026-10-11T06:00:00.000Z");

    // (c) same rain at the next check: no repeat.
    clock.advance(6 * HOUR);
    mark = chat.lastEntry();
    await runWeather(t);
    expect(chat.atlasSince(mark)).toEqual([]);
    expect(await alerts()).toHaveLength(1);
    expect(await q(`SELECT 1 FROM weather_snapshots`)).toHaveLength(9);

    // (d) "yeah swap it" in words: the agent calls the tool, the itinerary swaps, the poll closes.
    const replies = await chat.say("maya", "atlas yeah swap it");
    expect(replies.map((r) => r.text)).toEqual(["done: city market & lowcountry food tour moved to saturday, folly beach day to friday"]);
    const situation = (llm.calls.find((c) => c.role === "agent")!.contents[0]!.parts[0] as { text: string }).text;
    expect(situation).toContain("# forecast\nfri oct 16: cloudy, 82°\nsat oct 17: rain 70%, 81°\nsun oct 18: cloudy, 62°");
    expect(situation).toContain(`open weather swap poll "swap saturday's plan?" (swap them / keep the plan)`);
    expect(situation).toContain("call apply_weather_swap");
    const after = await tripRow(trip.id);
    expect(after.itinerary.map((d) => [d.date, d.items.map((i) => i.activityId)])).toEqual([
      [FRI, [BEACH.activityId]],
      [SAT, [FOOD_TOUR.activityId]],
      [SUN, [MUSEUM.activityId]],
    ]);
    expect((await swapPolls())[0]).toMatchObject({ status: "closed", winner_idx: 0 });

    // The summary line, and nothing left to answer.
    const tc = tcFor(row, after, clock);
    expect(await weatherFeature.summary!(tc)).toEqual(["forecast: fri cloudy 82°, sat rain 70%, sun cloudy 62°"]);
    expect((await weatherFeature.situation!(tc))!.lines.some((l) => l.includes("apply_weather_swap"))).toBe(false);
  });

  it("onPollDecided keeps the plan or applies the swap, and ignores other polls", async () => {
    const clock = new FixedClock(TODAY);
    setClock(clock);
    const meteo = fakeOpenMeteo();
    t = await testAtlas({ features: [weatherFeature] });
    const { chat, row, trip } = await lockedTrip(t, "wx2");
    await runWeather(t);
    meteo.state.edits = { [SAT]: { code: 63, precip: 70 } };
    clock.advance(6 * HOUR);
    await runWeather(t);
    expect(chat.transcript.filter((e) => e.kind === "poll")).toHaveLength(1);
    const [poll] = await swapPolls();

    const other = tcFor(row, trip, clock);
    expect(await weatherFeature.onPollDecided!({ ...poll!, kind: "destination" }, 0, other)).toBe(false);
    expect(other.out).toEqual([]);

    const keep = tcFor(row, trip, clock);
    expect(await weatherFeature.onPollDecided!(poll!, 1, keep)).toBe(true);
    expect(keep.out).toEqual([{ type: "say", text: "keeping the plan as is" }]);
    expect((await tripRow(trip.id)).itinerary).toEqual(ITINERARY);
    expect((await swapPolls())[0]).toMatchObject({ status: "closed", winner_idx: 1 });

    const swap = tcFor(row, trip, clock);
    expect(await weatherFeature.onPollDecided!(poll!, 0, swap)).toBe(true);
    expect(swap.out).toEqual([{ type: "say", text: "done: city market & lowcountry food tour moved to saturday, folly beach day to friday" }]);
    expect(swap.trip.itinerary[1]!.items[0]!.activityId).toBe(FOOD_TOUR.activityId);
    expect((await tripRow(trip.id)).itinerary[0]!.items[0]!.activityId).toBe(BEACH.activityId);

    // A second decision for the same swap is a no-op.
    const again = tcFor(row, swap.trip, clock);
    expect(await weatherFeature.onPollDecided!(poll!, 0, again)).toBe(true);
    expect(again.out).toEqual([]);
  });

  it("uses injected overrides without touching the network (sim extension: trip lock, inject, check)", async () => {
    const clock = new FixedClock(TODAY);
    setClock(clock);
    const offline = vi.fn(async () => {
      throw new Error("network must not be used when overrides cover the trip");
    });
    setWeatherFetch(offline as unknown as typeof fetch);
    t = await testAtlas({ features: [weatherFeature] });
    const chat = t.chat("wx3", ["maya", "leo", "priya"]);
    await chat.addAtlas();
    const app = t;
    const runner = { need: () => chat, runJobs: () => runWeather(app) } as unknown as ScenarioRunner;
    const ext = weatherSimExtension({} as SimSession);

    await ext["trip lock"]!("charleston 2026-10-16 2026-10-18", runner);
    const row = (await findChat("sim", "wx3"))!;
    let trip = await tripFor(row.id);
    expect(trip).toMatchObject({ status: "locked", destination_id: "charleston", destination_name: "Charleston", latitude: 32.7765, start_date: FRI, end_date: SUN });
    // Draft with no interests: fri king street (outdoor), sat folly beach + fort sumter (outdoor), sun food tour (indoor).
    expect(trip.itinerary.map((d) => d.items.map((i) => i.setting))).toEqual([["outdoor"], ["outdoor", "outdoor"], ["indoor"]]);
    expect(await q(`SELECT kind, payload FROM jobs WHERE singleton_key = $1`, [`weather:${trip.id}`])).toEqual([{ kind: "weather.check", payload: { tripId: trip.id, chatId: row.id } }]);

    await ext["weather inject"]!("all clear", runner);
    let mark = chat.lastEntry();
    await ext["weather check"]!("", runner);
    expect(chat.atlasSince(mark)).toEqual([]);
    expect(await q(`SELECT source, count(*)::int AS n FROM weather_snapshots GROUP BY source`)).toEqual([{ source: "override", n: 3 }]);

    await ext["weather inject"]!("2026-10-17 rain 70 64", runner);
    mark = chat.lastEntry();
    await ext["weather check"]!("", runner);
    const posted = chat.atlasSince(mark);
    expect(posted.map((e) => e.text)).toEqual([
      "saturday flipped to rain (70%). want to swap the folly beach day for the city market & lowcountry food tour on sunday?",
      "📊 swap saturday's plan?\n  1. swap them\n  2. keep the plan",
    ]);

    // The same rain again: quiet. The check ran on demand even though the next one was hours away.
    mark = chat.lastEntry();
    await ext["weather check"]!("", runner);
    expect(chat.atlasSince(mark)).toEqual([]);
    expect(offline).not.toHaveBeenCalled();

    trip = await tripFor(row.id);
    const tc = tcFor(row, trip, clock);
    expect((await weatherFeature.situation!(tc))!.lines.slice(0, 3)).toEqual([
      "fri oct 16: sunny, 78° (injected for rehearsal)",
      "sat oct 17: rain 70%, 64° (injected for rehearsal)",
      "sun oct 18: sunny, 78° (injected for rehearsal)",
    ]);

    // Clearing drops every override for the trip.
    await ext["weather clear"]!("", runner);
    expect(await q(`SELECT 1 FROM weather_overrides`)).toEqual([]);
  });

  it("warns once, says when the day clears up, holds a repeat inside the cooldown, and stops after the trip", async () => {
    const clock = new FixedClock(TODAY);
    setClock(clock);
    const meteo = fakeOpenMeteo();
    t = await testAtlas({ features: [weatherFeature] });
    const { chat } = await lockedTrip(t, "wx4");
    await runWeather(t);

    meteo.state.edits = { [SAT]: { code: 63, precip: 70 } };
    let mark = chat.lastEntry();
    await checkAt(t, clock, new Date("2026-10-10T22:00:00Z"));
    expect(chat.atlasSince(mark)[0]!.text).toBe(SWAP_MESSAGE);

    // Back to the dry fixture: good news, and the swap poll is withdrawn.
    meteo.state.edits = {};
    mark = chat.lastEntry();
    await checkAt(t, clock, new Date("2026-10-10T23:00:00Z"));
    expect(chat.atlasSince(mark).map((e) => e.text)).toEqual(["good news: saturday cleared up (cloudy, 81°), so no need to swap"]);
    expect((await swapPolls())[0]).toMatchObject({ status: "closed", winner_idx: null });

    // Rain again two hours after the first warning (a new UTC day, so not the daily cap): the cooldown holds it.
    meteo.state.edits = { [SAT]: { code: 63, precip: 70 } };
    mark = chat.lastEntry();
    await checkAt(t, clock, new Date("2026-10-11T01:00:00Z"));
    expect(chat.atlasSince(mark)).toEqual([]);
    expect(await alerts()).toEqual([
      { day: SAT, kind: "turned_wet" },
      { day: SAT, kind: "cleared_up" },
    ]);

    // A heads-up without a swap when the wet day's plan is all indoor.
    meteo.state.edits = { [SAT]: { code: 63, precip: 70 }, [SUN]: { code: 63, precip: 80 } };
    mark = chat.lastEntry();
    await checkAt(t, clock, new Date("2026-10-11T02:00:00Z"));
    expect(chat.atlasSince(mark).map((e) => e.text)).toEqual(["heads up: sunday flipped to rain (80%) — the plan's all indoor that day so we're fine"]);

    // The day after the trip ends the watch finishes for good.
    await checkAt(t, clock, new Date("2026-10-19T14:00:00Z"));
    expect((await weatherJob()).done_at).not.toBeNull();
  });

  it("records a failed forecast fetch and retries it with backoff", async () => {
    const clock = new FixedClock(TODAY);
    setClock(clock);
    const meteo = fakeOpenMeteo();
    meteo.state.fail = true;
    t = await testAtlas({ features: [weatherFeature] });
    const { chat, row } = await lockedTrip(t, "wx5");
    const mark = chat.lastEntry();
    await runWeather(t);
    expect(chat.atlasSince(mark)).toEqual([]);
    const job = await weatherJob();
    expect(job).toMatchObject({ done_at: null, attempts: 1 });
    expect(job.last_error).toMatch(/open-meteo network/);
    expect(job.due_at.getTime()).toBeGreaterThan(clock.now().getTime());
    expect(await q(`SELECT queue, chat_id FROM job_failures`)).toEqual([{ queue: "weather.check", chat_id: row.id }]);
    expect(await q(`SELECT 1 FROM weather_snapshots`)).toEqual([]);

    // Back online: the retry goes through.
    meteo.state.fail = false;
    clock.set(job.due_at);
    await runWeather(t);
    expect(await q(`SELECT 1 FROM weather_snapshots`)).toHaveLength(3);
    expect((await weatherJob()).attempts).toBe(0);
  });
});

describe("applySwap", () => {
  const replace: SwapProposal = {
    day: SAT,
    kind: "replace",
    outdoor: { activityId: BEACH.activityId, name: BEACH.name, costCents: 0 },
    replacement: { activityId: "charleston-gibbes-museum", name: "Gibbes Museum of Art", costCents: 1500 },
    message: "",
    pollOptions: ["swap it", "keep the plan"],
  };
  const plan: ItineraryDay[] = [{ date: SAT, items: [BEACH] }];

  it("replaces the outdoor item with the catalog activity", () => {
    const out = applySwap(plan, replace, "charleston");
    expect(out.status).toBe("applied");
    expect(out.itinerary[0]!.items[0]).toMatchObject({ activityId: "charleston-gibbes-museum", setting: "indoor", costCents: 1500, tags: ["culture"] });
    expect(plan[0]!.items[0]).toBe(BEACH); // input untouched
    expect(applySwap(out.itinerary, replace, "charleston").status).toBe("already");
  });

  it("refuses a swap the plan has moved past", () => {
    expect(applySwap([{ date: SAT, items: [MUSEUM] }], { ...replace, replacement: { ...replace.replacement, activityId: "x" } }).status).toBe("stale");
    expect(applySwap([], replace).status).toBe("stale");
  });
});
