// Food & activities in Postgres: after a booked stay the background job asks what food the group
// is into, then posts the shortlist (dietary needs and cuisines from facts, distances from the
// stay) once; numbered rows in trip_places, picks written onto the itinerary, a new shortlist that
// keeps picks. Cuisines already known from earlier in the chat skip the question.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import restaurants from "../fixtures/serpapi/google_maps_asheville_restaurants.json" with { type: "json" };
import things from "../fixtures/serpapi/google_maps_asheville_things_to_do.json" with { type: "json" };
import { ensureMember, upsertChat, upsertPerson } from "../../src/db/repos/core.ts";
import { insertFacts } from "../../src/profile/store.ts";
import { groupView } from "../../src/profile/groupView.ts";
import { buildShortlist, foodAsked, originFor, pickPlaces, suggestFromJob } from "../../src/agent/features/places.ts";
import { clearNearbyStubs, stubNearby } from "../../src/trips/nearby.ts";
import { placesFor } from "../../src/trips/placesStore.ts";
import { getStages, setStage } from "../../src/trips/stages.ts";
import { tripById, tripFor, updateTrip, type TripRow } from "../../src/trips/state.ts";
import type { Action } from "../../src/transport/outbound.ts";
import { dbAvailable, freshDb } from "../helpers/db.ts";

const describeDb = dbAvailable ? describe : describe.skip;
const AT = new Date("2026-10-10T18:00:00Z");

describeDb("food & activities (db)", () => {
  let drop: (() => Promise<void>) | undefined;
  let trip: TripRow;
  let chatId = 0;
  let maya = 0;

  beforeAll(async () => {
    drop = (await freshDb()).drop;
    const chat = await upsertChat("sim", "places-chat", true, AT);
    chatId = chat.id;
    maya = (await upsertPerson("+15550000001", AT, "Maya")).id;
    const leo = (await upsertPerson("+15550000002", AT, "Leo")).id;
    for (const p of [maya, leo]) await ensureMember(chat.id, p, AT);
    await insertFacts([
      { personId: maya, chatId, key: "dietary", value: { need: "vegetarian" }, polarity: "positive", explicit: true, confidence: 0.95, sourceMessageId: null, quote: "i'm vegetarian", observedAt: AT, retracted: false },
      { personId: leo, chatId, key: "activity", value: { tag: "music" }, polarity: "positive", explicit: true, confidence: 0.9, sourceMessageId: null, quote: "live music", observedAt: AT, retracted: false },
    ]);
    trip = await tripFor(chat.id);
    trip = await updateTrip(trip.id, { status: "locked", destination_id: "asheville", destination_name: "Asheville", start_date: "2026-11-12", end_date: "2026-11-15" });
    stubNearby("food", restaurants);
    stubNearby("activity", things);
  });
  afterAll(async () => {
    clearNearbyStubs();
    await drop?.();
  });

  it("measures from the destination until a stay is booked, then from the stay", async () => {
    expect(originFor(trip)).toMatchObject({ label: "downtown asheville" });
    trip = await updateTrip(trip.id, { stay: { name: "Aloft Asheville Downtown", kind: "hotel", lat: 35.5935, lon: -82.5536, booked_at: AT.toISOString() } });
    await setStage(trip.id, "stay", "decided");
    expect(originFor(trip)).toEqual({ lat: 35.5935, lon: -82.5536, label: "aloft asheville downtown" });
  });

  it("the background job asks about food first, then posts both shortlists once", async () => {
    const posted: Action[][] = [];
    const svc = { post: async (_chat: number, _guid: string, actions: Action[]) => void posted.push(actions) };
    // First run: the question, to everyone, and a check back once people have had time to answer.
    const first = await suggestFromJob(svc, trip.id, "g0");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual([{ type: "say", text: expect.stringMatching(/aloft asheville downtown is locked in[\s\S]*what kind of food is everyone into for this trip\?/) }]);
    expect(first).toEqual({ rescheduleAt: expect.any(Date), payload: { tripId: trip.id, asked: true } });
    expect((await foodAsked(chatId, trip.id)).people).toHaveLength(2);
    expect((await getStages(trip.id)).food_activities).toBe("in_progress");
    expect(await placesFor(trip.id)).toEqual([]);
    // Next run (answers in, or the wait is over): the lists.
    posted.length = 0;
    await suggestFromJob(svc, trip.id, "g1");
    expect(posted).toHaveLength(1);
    const texts = posted[0]!.map((a) => (a.type === "say" ? a.text : ""));
    expect(texts[0]).toContain("🍽️ places to eat near aloft asheville downtown (vegetarian-friendly for maya)");
    expect(texts[0]).not.toMatch(/ruth's chris|buxton hall/i);
    expect(texts[1]).toMatch(/^🎟️ things to do/);
    expect(texts[1]).toContain("6. The Orange Peel");
    expect(texts.join("\n")).not.toContain("$");
    expect((await getStages(trip.id)).food_activities).toBe("in_progress");
    const rows = await placesFor(trip.id);
    expect(rows.map((r) => r.idx)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows.every((r) => r.distance_m !== null && r.status === "suggested")).toBe(true);
    // Once there's a list, the job doesn't post again.
    await suggestFromJob(svc, trip.id, "g2");
    expect(posted).toHaveLength(1);
  });

  it("picks go on the itinerary and are saved with who picked them", async () => {
    const { outcome, trip: next } = await pickPlaces(trip, ["2", "the orange peel", "nowhere"], maya, AT);
    trip = next;
    expect(outcome.added.map((a) => [a.row.idx, a.date, a.time])).toEqual([
      [2, "2026-11-12", "dinner"],
      [6, "2026-11-13", "morning"],
    ]);
    expect(outcome.unknown).toEqual(["nowhere"]);
    const saved = (await tripById(trip.id))!;
    const items = saved.itinerary.flatMap((d) => d.items.map((i) => ({ date: d.date, ...i })));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ date: "2026-11-12", time: "dinner", setting: "indoor", costCents: 0 });
    expect(items[0]!.activityId).toMatch(/^place:food:/);
    expect(items[0]!.notes).toMatch(/★/);
    const picked = (await placesFor(trip.id)).filter((r) => r.status === "picked");
    expect(picked.map((r) => [r.idx, r.picked_by, r.day])).toEqual([
      [2, maya, "2026-11-12"],
      [6, maya, "2026-11-13"],
    ]);
    const again = await pickPlaces(trip, ["2"], maya, AT);
    expect(again.outcome.already.map((r) => r.idx)).toEqual([2]);
    expect(again.outcome.added).toEqual([]);
  });

  it("a fresh shortlist replaces unpicked suggestions and leaves picks out", async () => {
    const view = groupView([], "2026-11-12");
    const list = await buildShortlist(trip, view, ["food"], { at: AT });
    expect(list.texts).toHaveLength(1);
    const rows = await placesFor(trip.id);
    const picked = rows.filter((r) => r.status === "picked");
    expect(picked).toHaveLength(2);
    const food = rows.filter((r) => r.kind === "food" && r.status === "suggested");
    expect(food).toHaveLength(5);
    expect(food.map((r) => r.name)).not.toContain(picked.find((r) => r.kind === "food")!.name);
    expect(food.map((r) => r.idx)).toEqual([1, 2, 3, 4, 5]);
    // Activities from the first list keep their numbers.
    expect(rows.filter((r) => r.kind === "activity" && r.status === "suggested").map((r) => r.idx)).toEqual([7, 8, 9, 10]);
  });

  it("skips the question when most of the group said what they like to eat earlier in the chat", async () => {
    const chat2 = await upsertChat("sim", "places-chat-2", true, AT);
    const ana = (await upsertPerson("+15550000011", AT, "Ana")).id;
    const sol = (await upsertPerson("+15550000012", AT, "Sol")).id;
    for (const p of [ana, sol]) await ensureMember(chat2.id, p, AT);
    await insertFacts([
      { personId: ana, chatId: chat2.id, key: "cuisine", value: { name: "indian" }, polarity: "positive", explicit: true, confidence: 0.9, sourceMessageId: null, quote: "indian always", observedAt: AT, retracted: false },
      { personId: sol, chatId: chat2.id, key: "cuisine", value: { name: "tacos" }, polarity: "positive", explicit: true, confidence: 0.9, sourceMessageId: null, quote: "tacos", observedAt: AT, retracted: false },
    ]);
    let t2 = await tripFor(chat2.id);
    t2 = await updateTrip(t2.id, { status: "locked", destination_id: "asheville", destination_name: "Asheville", start_date: "2026-11-12", end_date: "2026-11-15", stay: { name: "Aloft Asheville Downtown", kind: "hotel", lat: 35.5935, lon: -82.5536, booked_at: AT.toISOString() } });
    await setStage(t2.id, "stay", "decided");
    const posted: Action[][] = [];
    await suggestFromJob({ post: async (_c, _g, actions) => void posted.push(actions) }, t2.id, "h1");
    expect(posted).toHaveLength(1);
    const food = posted[0]![0]!;
    expect(food.type === "say" && food.text).toMatch(/^going off what you've said you like to eat \(ana: indian · sol: tacos\)\n🍽️ places to eat/);
    expect(food.type === "say" && food.text).toMatch(/Chai Pani/);
    expect(food.type === "say" && food.text).toMatch(/Mamacita's Taqueria/);
    expect((await foodAsked(chat2.id, t2.id)).at).toBeNull();
  });
});
