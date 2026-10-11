// Stages and travel plans in Postgres: explicit stages stored over inferred ones, no silent
// downgrade, reopen cascades, and travel plans that keep people's own choices across a reset.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { one } from "../../src/db/pool.ts";
import { upsertChat, upsertPerson } from "../../src/db/repos/core.ts";
import { getStages, reopenStage, setStage } from "../../src/trips/stages.ts";
import { tripFor, updateTrip } from "../../src/trips/state.ts";
import { resetTravelPlans, saveTravelPlans, travelOverrides, travelPlansFor, type TravelLeg } from "../../src/trips/travel.ts";
import { dbAvailable, freshDb } from "../helpers/db.ts";

const describeDb = dbAvailable ? describe : describe.skip;
const AT = new Date("2026-10-10T18:00:00Z");

const leg = (personId: number, over: Partial<TravelLeg> = {}): TravelLeg => ({
  personId,
  name: `p${personId}`,
  mode: "drive",
  origin: "Raleigh",
  originIata: "RDU",
  hours: 3,
  costCents: 3_200,
  costSource: "estimate",
  carpoolGroup: null,
  carpoolWith: [],
  overridden: false,
  link: null,
  ...over,
});

describeDb("trip stages and travel plans (db)", () => {
  let drop: (() => Promise<void>) | undefined;
  let tripId = 0;
  let people: number[] = [];

  beforeAll(async () => {
    drop = (await freshDb()).drop;
    const chat = await upsertChat("sim", "stages-chat", true, AT);
    tripId = (await tripFor(chat.id)).id;
    people = [];
    for (const h of ["+15550000001", "+15550000002", "+15550000003"]) people.push((await upsertPerson(h, AT)).id);
  });
  afterAll(async () => {
    await drop?.();
  });

  it("a new trip starts with everything open, nothing stored", async () => {
    expect(await getStages(tripId)).toEqual({ location: "open", dates: "open", travel: "open", stay: "open", food_activities: "open" });
    expect((await one<{ stages: object }>(`SELECT stages FROM trips WHERE id = $1`, [tripId]))!.stages).toEqual({});
  });

  it("stores only what was set; the rest still follows the trip row", async () => {
    await setStage(tripId, "dates", "decided");
    await updateTrip(tripId, { status: "voting" });
    const s = await getStages(tripId);
    expect(s.dates).toBe("decided");
    expect(s.location).toBe("in_progress"); // inferred from voting
    expect((await one<{ stages: object }>(`SELECT stages FROM trips WHERE id = $1`, [tripId]))!.stages).toEqual({ dates: "decided" });
  });

  it("never quietly downgrades a decided stage to in progress", async () => {
    await setStage(tripId, "dates", "in_progress");
    expect((await getStages(tripId)).dates).toBe("decided");
    await setStage(tripId, "dates", "in_progress", { force: true });
    expect((await getStages(tripId)).dates).toBe("in_progress");
  });

  it("reopening location resets dates and everything after", async () => {
    for (const s of ["location", "dates", "travel", "stay"] as const) await setStage(tripId, s, "decided");
    const { stages, reset } = await reopenStage(tripId, "location");
    expect(stages).toEqual({ location: "in_progress", dates: "open", travel: "open", stay: "open", food_activities: "open" });
    expect(reset).toEqual(["dates", "travel", "stay"]);
    expect(await getStages(tripId)).toEqual(stages);
  });

  it("travel plans save, update in place, and drop people who left", async () => {
    const [a, b, c] = people as [number, number, number];
    await saveTravelPlans(tripId, [leg(a, { carpoolGroup: "rdu-1" }), leg(b, { carpoolGroup: "rdu-1" }), leg(c, { mode: "fly", costCents: 18_500, link: "https://x" })], AT);
    expect((await travelPlansFor(tripId)).map((r) => [r.person_id, r.mode, r.est_cost_cents])).toEqual([
      [a, "drive", 3_200],
      [b, "drive", 3_200],
      [c, "fly", 18_500],
    ]);
    await saveTravelPlans(tripId, [leg(a), leg(c, { mode: "drive", overridden: true })], AT);
    const rows = await travelPlansFor(tripId);
    expect(rows.map((r) => r.person_id)).toEqual([a, c]);
    expect(rows.find((r) => r.person_id === c)).toMatchObject({ mode: "drive", overridden: true });
  });

  it("a reset clears computed plans but keeps people's own choices", async () => {
    await resetTravelPlans(tripId);
    const rows = await travelPlansFor(tripId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ person_id: people[2], mode: "drive", overridden: true, est_cost_cents: null, hours: null });
    expect(await travelOverrides(tripId)).toEqual(new Map([[people[2], "drive"]]));
  });

  it("the stay column takes the agreed shape", async () => {
    const stay = { name: "Creekside cabin", kind: "rental" as const, lat: 36.2, lon: -81.6, check_in: "2026-11-12", check_out: "2026-11-15", total_cents: 84_000, per_person_night_cents: 9_300, rating: 4.8, link: "https://example.org", booked_at: null, address: null };
    const t = await updateTrip(tripId, { stay });
    expect(t.stay).toEqual(stay);
    expect((await getStages(tripId)).stay).toBe("open"); // explicitly reset above, so not inferred
  });
});
