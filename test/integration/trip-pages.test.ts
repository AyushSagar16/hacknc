// Trip pages end to end on the simulator: several trips per chat, publishing to the site store
// before linking, silent chat sync, and background research.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { q } from "../../src/db/pool.ts";
import { callResult, textResult, type GenerateRequest, type GenerateResult } from "../../src/agent/llm.ts";
import { OffsetClock, isoDate, setClock, systemClock } from "../../src/clock.ts";
import { MemorySiteStore, useSite } from "../../src/site/store.ts";
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

const researchAnswer = (req: GenerateRequest): GenerateResult => {
  const topic = /topic: (.+)$/.exec((req.contents[0]!.parts[0] as { text: string }).text)?.[1] ?? "?";
  const text = `SUMMARY: The short version on ${topic.toLowerCase()}.\n\n- one useful thing about ${topic.toLowerCase()} that is long enough to count\n- and another useful thing`;
  return { text, functionCalls: [], parts: [{ text }], sources: [{ title: "example.org", url: "https://example.org/guide" }] };
};

describeDb("trip pages", () => {
  let t: TestAtlas | undefined;
  let store: MemorySiteStore;
  const clock = new OffsetClock();

  beforeEach(() => {
    store = new MemorySiteStore();
    useSite({ store, baseUrl: BASE });
    setClock(clock);
  });
  afterEach(async () => {
    await t?.close();
    t = undefined;
    useSite(undefined);
    setClock(systemClock);
  });

  async function lockedTrip() {
    const llm = quietFake().set("research", researchAnswer);
    t = await testAtlas({ llm });
    const chat = t.chat("p1", ["maya", "leo", "priya"]);
    await pastIntro(chat);
    const before = chat.lastEntry();
    const [start, end] = [plusDays(40), plusDays(43)];
    llm.set("agent", scripted([
      { name: "set_trip_dates", args: { start, end } },
      { name: "lock_destination", args: { destination: "asheville" } },
      { name: "update_itinerary", args: planFor(start) },
    ]));
    await chat.say("maya", "atlas we're all good with asheville, lock it in");
    return { llm, chat, before, start, end };
  }

  it("puts the plan Atlas writes on the page, links it after the lock-in, then researches", async () => {
    const { llm, chat, before, start } = await lockedTrip();
    const [trip] = await q<{ public_id: string; site_version: number }>(`SELECT public_id, site_version FROM trips`);
    const sent = chat.atlasSince(before);
    const link = sent.at(-1)!;
    expect(link.kind).toBe("link");
    expect(link.text).toBe(`${BASE}/t/${trip!.public_id}/itinerary?v=${trip!.site_version}`);
    expect(sent.slice(0, -1).some((e) => /asheville is locked in/.test(e.text))).toBe(true);
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

    // Locking queued the default research; the job posts a summary and the research link.
    const mark = chat.lastEntry();
    await t!.app.jobs.runDue();
    await t!.world.waitIdle("p1");
    expect(llm.calls.filter((c) => c.role === "research")).toHaveLength(5);
    expect(llm.calls.find((c) => c.role === "research")!.grounding).toBe("google_search");
    const after = chat.atlasSince(mark);
    expect(after[0]!.text).toMatch(/^did some digging on asheville:\ngetting there & entry: the short version/);
    expect(after.at(-1)!.text).toMatch(new RegExp(`^${BASE}/t/${trip!.public_id}/research\\?v=\\d+$`));
    const notes = [...store.research.get(trip!.public_id)!.values()];
    expect(notes.map((n) => n.topic)).toEqual(["Getting there & entry", "Weather & packing", "Where to stay", "Food", "Local tips"]);
    expect(notes[0]!.sources).toEqual([{ title: "example.org", url: "https://example.org/guide" }]);
  });

  it("asks Atlas to write the plan when a vote locked the trip, and keeps the summary it sets", async () => {
    const { llm, chat } = await lockedTrip();
    const [trip] = await q<{ id: number; start_date: string; public_id: string }>(`SELECT id, start_date, public_id FROM trips`);
    // As if the poll had locked it: no plan yet and no agent in that turn.
    const { updateTrip, tripById } = await import("../../src/trips/state.ts");
    const { siteFeature } = await import("../../src/agent/features/site.ts");
    await updateTrip(trip!.id, { itinerary: [] });
    await siteFeature.onTripLocked!((await tripById(trip!.id))!, { notes: new Map() } as never);

    const before = chat.lastEntry();
    llm.set("agent", (req) =>
      JSON.stringify(req.contents).includes("locked in by the vote")
        ? scripted([
            { name: "update_itinerary", args: planFor(trip!.start_date) },
            { name: "set_trip_summary", args: { summary: "Asheville is locked in. Next up: book the Biltmore." } },
          ])(req)
        : textResult("NO_REPLY"),
    );
    clock.advance(5_000);
    await t!.app.jobs.runDue();
    await t!.world.waitIdle("p1");
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
    expect(results).toEqual([
      { ok: false, error: expect.stringMatching(/leave prices out/) },
      expect.anything(),
      { ok: false, error: expect.stringMatching(/outside the trip/) },
    ]);
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
    const onFirst = await factsFor([maya!.id], { tripId: first!.id });
    const onSecond = await factsFor([maya!.id], { tripId: second.id });
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
