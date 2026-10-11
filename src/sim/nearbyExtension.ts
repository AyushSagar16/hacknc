// Simulator steps for food & activities, so scenarios never touch the network:
//   nearby food google_maps_asheville_restaurants.json      answer restaurant searches from a fixture
//   nearby activity google_maps_asheville_things_to_do.json answer things-to-do searches
//   stay booked Aloft Asheville Downtown | 35.5935 -82.5536 a booked stay on the focused trip
// Fixtures are read from test/fixtures/serpapi. Stubs are cleared for every new scenario.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { now } from "../clock.ts";
import { findChat } from "../db/repos/core.ts";
import { clearNearbyStubs, stubNearby } from "../trips/nearby.ts";
import { setStage } from "../trips/stages.ts";
import { tripFor, updateTrip } from "../trips/state.ts";
import type { Extension } from "./extensions.ts";
import type { SimSession } from "./session.ts";

export function nearbySimExtension(_session: SimSession): Record<string, Extension> {
  clearNearbyStubs();
  return {
    nearby: async (args) => {
      const m = /^(food|activity)\s+(\S+)$/.exec(args.trim());
      if (!m) throw new Error("usage: nearby food|activity <fixture.json>");
      const body = JSON.parse(await readFile(join(process.cwd(), "test", "fixtures", "serpapi", m[2]!), "utf8"));
      stubNearby(m[1] as "food" | "activity", body);
    },
    "stay booked": async (args, runner) => {
      const [name, coords] = args.split("|").map((s) => s.trim());
      const m = /^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/.exec(coords ?? "");
      if (!name || !m) throw new Error("usage: stay booked <name> | <lat> <lon>");
      const chat = await findChat("sim", runner.need().id);
      if (!chat) throw new Error("atlas hasn't seen this chat yet");
      const trip = await tripFor(chat.id);
      await updateTrip(trip.id, {
        stay: { name, kind: "hotel", lat: Number(m[1]), lon: Number(m[2]), check_in: trip.start_date, check_out: trip.end_date, booked_at: now().toISOString() },
      });
      await setStage(trip.id, "stay", "decided");
    },
  };
}
