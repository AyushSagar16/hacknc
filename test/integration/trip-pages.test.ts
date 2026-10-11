// Trip pages end to end on the simulator: several trips per chat, publishing to the site store
// before linking, silent chat sync, background research (saved, never posted), and the
// day-by-day plan only once the stay is picked.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { q } from "../../src/db/pool.ts";
import { callResult, textResult, type GenerateRequest, type GenerateResult } from "../../src/agent/llm.ts";
import { OffsetClock, isoDate, setClock, systemClock } from "../../src/clock.ts";
import { MemorySiteStore, useSite } from "../../src/site/store.ts";
import { setResearchLookup } from "../../src/agent/features/research.ts";
import type { Lookup, LookupInput } from "../../src/agent/features/search.ts";
import { dbAvailable } from "../helpers/db.ts";
import { pastIntro, quietFake, testAtlas, type TestAtlas } from "../helpers/atlas.ts";

const describeDb = dbAvailable ? describe : describe.skip;
const BASE = "https://trips.test";

type Step = { name: string; args: Record<string, unknown> };

/** An agent that makes these tool calls in order (one per round), then says `final`. */
function scripted(steps: Step[], final = "NO_REPLY") {
  return (req: GenerateRequest): GenerateResult => {
    const done = req.contents.flatMap((c) => c.parts).filter((p) => "functionResponse" in p).length;
    const step = steps[done];
    return step ? callResult(step.name, step.args) : textResult(final);
  };
}

const plusDays = (n: number) => isoDate(new Date(Date.now() + n * 86_400_000), "UTC");

/** What the agent writes: a catalog activity (by its everyday name) and a place of its own. */
const planFor = (start: string) => ({
  days: [
    {
      date: start,
      title: "Arrive + Biltmore",
      items: [
        { name: "Biltmore Estate", time: "1pm", setting: "either", notes: "book the timed house entry" },
        { name: "Dinner at Cúrate", time: "7pm", setting: "indoor" },
      ],
    },
  ],
});

/** The web lookups research makes, answered without the network. */
const lookups: LookupInput[] = [];
const fakeLookup = async (input: LookupInput): Promise<Lookup> => {
  lookups.push(input);
  return input.purpose === "events"
    ? { kind: "list", heading: "events in asheville", items: [{ name: "winter lights", detail: "garden light show", start: "2026-11-20", end: "2027-01-03" }, { name: "craft fair", detail: "local makers" }], source: "https://example.org/events" }
    : { kind: "list", heading: input.query, items: [{ name: "biltmore estate", detail: "house and gardens" }, { name: "white duck tacos", detail: "creative tacos" }], source: "https://example.org/guide" };
};

describeDb("trip pages", () => {
  let t: TestAtlas | undefined;
  let store: MemorySiteStore;
  const clock = new OffsetClock();

  beforeEach(() => {
    store = new MemorySiteStore();
    useSite({ store, baseUrl: BASE });
    setClock(clock);
    lookups.length = 0;
    setResearchLookup(fakeLookup);
  });
  afterEach(async () => {
    await t?.close();
    t = undefined;
    useSite(undefined);
    setClock(systemClock);
    setResearchLookup(undefined);
  });

  /** Lock asheville (no plan yet), book a stay, then have Atlas write the plan. */
  async function lockedTrip() {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("p1", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    const before = chat.lastEntry();
    const [start, end] = [plusDays(40), plusDays(43)];
    llm.set("agent", scripted([
      { name: "set_trip_dates", args: { start, end } },
      { name: "lock_destination", args: { destination: "asheville" } },
    ]));
    await chat.say("maya", "atlas we're all good with asheville, lock it in");
    const locked = chat.atlasSince(before);
    await bookStay();
    const planned = chat.lastEntry();
    llm.set("agent", scripted([{ name: "update_itinerary", args: planFor(start) }]));
    await chat.say("maya", "atlas ok write up the plan");
    return { llm, chat, before, locked, planned, start, end };
  }

  /** The stay stage's outcome, without its search: a booked hotel and the stage decided. */
  async function bookStay() {
    const { updateTrip, tripFor } = await import("../../src/trips/state.ts");
    const { setStage } = await import("../../src/trips/stages.ts");
    const [row] = await q<{ id: number }>(`SELECT id FROM chats WHERE provider_chat_id = 'p1'`);
    const trip = await tripFor(Number(row!.id));
    await updateTrip(trip.id, { stay: { name: "Aloft Asheville Downtown", kind: "hotel", lat: 35.5935, lon: -82.5536, check_in: trip.start_date, check_out: trip.end_date, booked_at: new Date().toISOString() } });
    await setStage(trip.id, "stay", "decided");
  }

  it("puts the plan Atlas writes on the page once the stay is picked, links it, and researches quietly", async () => {
    const { llm, chat, locked, planned, start } = await lockedTrip();
    const [trip] = await q<{ public_id: string; site_version: number }>(`SELECT public_id, site_version FROM trips`);
    // The lock-in itself writes no plan and posts no itinerary link.
    expect(locked.some((e) => /asheville it is!\nlocked in for/.test(e.text))).toBe(true);
    expect(locked.some((e) => e.kind === "link")).toBe(false);
    const sent = chat.atlasSince(planned);
    const link = sent.at(-1)!;
    expect(link.kind).toBe("link");
    expect(link.text).toBe(`${BASE}/t/${trip!.public_id}/itinerary?v=${trip!.site_version}`);
    expect(sent.filter((e) => e.kind === "link")).toHaveLength(1);
    expect(sent.some((e) => /rough plan/.test(e.text))).toBe(false);

    const page = store.trips.get(trip!.public_id)!;
    expect(page.status).toBe("locked");
    expect(page.destination).toBe("Asheville");
    // Every trip day is on the page; the first is exactly what the agent wrote, with the
    // catalog's cost for the activity it recognized and none for its own pick.
    expect(page.itinerary).toHaveLength(4);
    expect(page.itinerary[0]).toEqual({
      date: start,
      title: "Arrive + Biltmore",
      items: [
        expect.objectContaining({ name: "Biltmore Estate", time: "1pm", notes: "book the timed house entry", cost: expect.stringMatching(/^~\$\d+ pp$/) }),
        { name: "Dinner at Cúrate", time: "7pm", setting: "indoor", cost: undefined, notes: undefined },
      ],
    });
    expect(page.itinerary[1]!.items).toEqual([]);
    expect(page.travelers).toEqual(["Maya", "Leo", "Priya"]);
    expect(page.overview.booking.map((b) => b.label)).toContain("stays");

    // Locking queued the default research; the job saves its notes and posts nothing.
    const mark = chat.lastEntry();
    await t!.app.jobs.runDue();
    await t!.world.waitIdle("p1");
    expect(lookups.map((l) => l.purpose)).toEqual(["things_to_do", "food", "events"]);
    expect(lookups[2]!.window).toEqual({ start, end: expect.any(String) });
    void llm;
    clock.advance(4_500);
    await t!.app.jobs.runDue();
    await t!.world.waitIdle("p1");
    const after = chat.atlasSince(mark);
    expect(after.some((e) => /did some digging/.test(e.text))).toBe(false);
    expect(after.some((e) => /\/research/.test(e.text))).toBe(false);
    const notes = [...store.research.get(trip!.public_id)!.values()];
    expect(notes.map((n) => n.topic)).toEqual(["Things to do", "Food", "Events during the trip"]);
    expect(notes[0]!.sources).toEqual([{ title: "example.org", url: "https://example.org/guide" }]);
  });

  it("asks Atlas to write the plan once the group has picked its food & things to do, and keeps the summary it sets", async () => {
    const { llm, chat } = await lockedTrip();
    const [trip] = await q<{ id: number; start_date: string; public_id: string }>(`SELECT id, start_date, public_id FROM trips`);
    // As if the picks had just been settled: no plan yet and no agent in that turn.
    const { updateTrip, tripById } = await import("../../src/trips/state.ts");
    const { requestItinerary } = await import("../../src/agent/features/site.ts");
    await updateTrip(trip!.id, { itinerary: [], plan_written_at: null });
    await requestItinerary((await tripById(trip!.id))!, "picked");

    const before = chat.lastEntry();
    llm.set("agent", (req) =>
      JSON.stringify(req.contents).includes("picked its food & things to do")
        ? scripted([
            { name: "update_itinerary", args: planFor(trip!.start_date) },
            { name: "set_trip_summary", args: { summary: "Asheville is locked in. Next up: book the Biltmore." } },
          ])(req)
        : textResult("NO_REPLY"),
    );
    // A nudge is skipped while another turn is still finishing; the job checks back 90 s later.
    clock.advance(5_000);
    for (let i = 0; i < 3 && !chat.atlasSince(before).some((e) => e.kind === "link"); i++) {
      await t!.app.jobs.runDue();
      await t!.world.waitIdle("p1");
      clock.advance(91_000);
    }
    expect(chat.atlasSince(before).at(-1)!.text).toMatch(new RegExp(`^${BASE}/t/${trip!.public_id}/itinerary\\?v=\\d+$`));
    clock.advance(10_000);
    await t!.app.jobs.runDue();
    const page = store.trips.get(trip!.public_id)!;
    expect(page.itinerary[0]!.items.map((i) => i.name)).toEqual(["Biltmore Estate", "Dinner at Cúrate"]);
    expect(page.summary).toBe("Asheville is locked in. Next up: book the Biltmore.");
  });

  it("rejects a plan with prices or dates outside the trip, so the model can fix it", async () => {
    const { llm, chat, start } = await lockedTrip();
    const results: unknown[] = [];
    llm.set("agent", (req) => {
      const responses = req.contents.flatMap((c) => c.parts).filter((p) => "functionResponse" in p);
      results.push(...responses.map((p) => (p as { functionResponse: { response: unknown } }).functionResponse.response));
      if (responses.length === 0) return callResult("update_itinerary", { days: [{ date: start, items: [{ name: "Boat tour ($40)", setting: "outdoor" }] }] });
      if (responses.length === 1) return callResult("update_itinerary", { days: [{ date: "2020-01-01", items: [{ name: "Hike", setting: "outdoor" }] }] });
      return textResult("NO_REPLY");
    });
    await chat.say("maya", "atlas add a boat tour");
    // Each bad plan comes back as an error the model can act on, and nothing was saved.
    const errors = new Set((results as { ok: boolean; error?: string }[]).filter((r) => !r.ok).map((r) => r.error));
    expect([...errors]).toEqual([expect.stringMatching(/leave prices out/), expect.stringMatching(/outside the trip/)]);
    const [saved] = await q<{ itinerary: { items: { name: string }[] }[] }>(`SELECT itinerary FROM trips`);
    expect(saved!.itinerary.flatMap((d) => d.items.map((i) => i.name))).not.toContain("Boat tour ($40)");
  });

  it("won't write the day-by-day plan before the stay is picked", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const chat = t.chat("p1", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    const [start, end] = [plusDays(40), plusDays(43)];
    const results: { ok: boolean; error?: string }[] = [];
    llm.set("agent", (req) => {
      const responses = req.contents.flatMap((c) => c.parts).filter((p) => "functionResponse" in p);
      results.push(...responses.map((p) => (p as { functionResponse: { response: unknown } }).functionResponse.response as { ok: boolean; error?: string }));
      return scripted([
        { name: "set_trip_dates", args: { start, end } },
        { name: "lock_destination", args: { destination: "asheville" } },
        { name: "update_itinerary", args: planFor(start) },
      ])(req);
    });
    await chat.say("maya", "atlas lock asheville and give us the itinerary");
    expect(results.at(-1)).toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(/stay isn't picked yet/) }));
    const [saved] = await q<{ itinerary: { items: unknown[] }[]; plan_written_at: Date | null }>(`SELECT itinerary, plan_written_at FROM trips`);
    expect(saved!.itinerary.flatMap((d) => d.items)).toEqual([]);
    expect(saved!.plan_written_at).toBeNull();
    // Locking no longer asks Atlas for a plan either.
    expect((await q(`SELECT 1 FROM jobs WHERE kind = 'site.itinerary_nudge'`)).length).toBe(0);
  });

  it("syncs the chat to the page with first names only", async () => {
    await lockedTrip();
    clock.advance(10_000);
    await t!.app.jobs.runDue();
    const [trip] = await q<{ public_id: string }>(`SELECT public_id FROM trips`);
    const lines = [...store.messages.get(trip!.public_id)!.values()];
    expect(lines.some((m) => m.sender === "Maya" && m.text.includes("lock it in"))).toBe(true);
    expect(lines.some((m) => m.fromAtlas && m.sender === "Atlas")).toBe(true);
    expect(JSON.stringify(lines)).not.toMatch(/\+1555/);
  });

  it("starts a second trip with its own page, keeps trip facts apart, and switches back", async () => {
    const { llm, chat } = await lockedTrip();
    const [first] = await q<{ id: number; public_id: string }>(`SELECT id, public_id FROM trips`);

    let before = chat.lastEntry();
    llm.set("agent", scripted([{ name: "start_trip", args: { title: "Japan" } }], "japan! when's everyone free?"));
    await chat.say("leo", "atlas let's also plan japan for june");
    const trips = await q<{ id: number; public_id: string; title: string | null; status: string }>(`SELECT id, public_id, title, status FROM trips ORDER BY id`);
    expect(trips).toHaveLength(2);
    const japan = trips[1]!;
    expect(japan.public_id).not.toBe(first!.public_id);
    expect(japan.title).toBe("japan");
    expect(japan.status).toBe("planning");
    const [chatRow] = await q<{ focus_trip_id: number }>(`SELECT focus_trip_id FROM chats WHERE provider_chat_id = 'p1'`);
    expect(chatRow!.focus_trip_id).toBe(japan.id);
    const sent = chat.atlasSince(before);
    expect(sent.map((e) => e.text)).toEqual(["japan! when's everyone free?", expect.stringMatching(new RegExp(`^${BASE}/t/${japan.public_id}\\?v=1$`))]);
    expect(store.trips.get(japan.public_id)!.title).toBe("Japan");

    // The new trip's turn sees the old trip in its situation, and none of its dates.
    llm.set("agent", () => textResult("NO_REPLY"));
    await chat.say("maya", "atlas any thoughts on flights for that");
    const situation = (llm.calls.filter((c) => c.role === "agent").at(-1)!.contents[0]!.parts[0] as { text: string }).text;
    expect(situation).toContain("name: japan");
    expect(situation).toContain("dates: not set");
    expect(situation).toMatch(/- asheville \(locked/i);
    expect(situation).toContain(`${BASE}/t/${japan.public_id}`);

    // Messages belong to the trip that was focused when they arrived.
    const stamped = await q<{ trip_id: number }>(`SELECT DISTINCT trip_id FROM messages WHERE text LIKE '%thoughts on flights%'`);
    expect(stamped.map((r) => r.trip_id)).toEqual([japan.id]);

    before = chat.lastEntry();
    llm.set("agent", scripted([{ name: "switch_trip", args: { trip: "asheville" } }]));
    await chat.say("priya", "atlas wait back to asheville, what are we doing saturday");
    const [focus] = await q<{ focus_trip_id: number }>(`SELECT focus_trip_id FROM chats WHERE provider_chat_id = 'p1'`);
    expect(focus!.focus_trip_id).toBe(first!.id);
    expect(chat.atlasSince(before).at(-1)!.text).toMatch(new RegExp(`^${BASE}/t/${first!.public_id}\\?v=\\d+$`));
  });

  it("scopes where/when facts to their trip but carries person facts across", async () => {
    const { chat } = await lockedTrip();
    const [first] = await q<{ id: number }>(`SELECT id FROM trips`);
    const [maya] = await q<{ id: number }>(`SELECT id FROM people WHERE display_name = 'Maya'`);
    const [msg] = await q<{ id: number }>(`SELECT id FROM messages WHERE person_id = $1 ORDER BY id DESC LIMIT 1`, [maya!.id]);
    const { insertFacts, factsFor } = await import("../../src/profile/store.ts");
    const [chatRow] = await q<{ id: number }>(`SELECT id FROM chats WHERE provider_chat_id = 'p1'`);
    const base = { personId: maya!.id, chatId: chatRow!.id, polarity: "positive" as const, explicit: true, confidence: 0.9, sourceMessageId: msg!.id, quote: null, observedAt: new Date(), retracted: false };
    await insertFacts([
      { ...base, key: "trip_length", value: { min: 3, max: 4 } },
      { ...base, key: "dietary", value: { need: "vegetarian" } },
    ]);
    const { createTrip } = await import("../../src/trips/state.ts");
    const second = await createTrip(chatRow!.id, "japan");
    const onFirst = await factsFor([maya!.id], { chatId: chatRow!.id, tripId: first!.id });
    const onSecond = await factsFor([maya!.id], { chatId: chatRow!.id, tripId: second.id });
    expect(onFirst.map((f) => f.key).sort()).toEqual(["dietary", "trip_length"]);
    expect(onSecond.map((f) => f.key)).toEqual(["dietary"]);
    void chat;
  });

  it("never publishes a private chat", async () => {
    const llm = quietFake();
    t = await testAtlas({ llm });
    const dm = t.chat("dm1", ["maya"]);
    await dm.say("maya", "hey");
    clock.advance(10_000);
    await t.app.jobs.runDue();
    expect(store.trips.size).toBe(0);
  });
});
