// Simulator steps for rehearsing the weather watch without waiting on real weather:
//   trip lock charleston 2026-10-16 2026-10-18     lock the chat's trip at a catalog destination
//   weather inject 2026-10-17 rain 70 64            override one day's forecast (or "all" days)
//   weather clear                                   drop every override for the trip
//   weather check                                   run the trip's forecast check now
// Overrides win over Open-Meteo in the real job, so the demo shows exactly the injected weather.
import { now } from "../clock.ts";
import { q } from "../db/pool.ts";
import { findChat } from "../db/repos/core.ts";
import { enqueueJob } from "../pipeline/jobs.ts";
import { destinationById, findDestination } from "../trips/catalog.ts";
import { draftItinerary } from "../trips/itinerary.ts";
import { tripFor, updateTrip, type TripRow } from "../trips/state.ts";
import type { WeatherCategory } from "../weather/classify.ts";
import type { DailyForecast } from "../weather/openMeteo.ts";
import { startWeatherWatch, tripDays, WEATHER_JOB, weatherJobKey } from "../agent/features/weather.ts";
import type { Extension } from "./extensions.ts";
import type { ScenarioRunner } from "./script.ts";
import type { SimSession } from "./session.ts";

/** A representative WMO code per category (what Open-Meteo would send). */
const CODES: Record<WeatherCategory, number> = { clear: 0, cloudy: 3, rain: 63, storm: 95, snow: 73 };

const DEFAULTS: Record<WeatherCategory, { precip: number; tmaxF: number; gustMph: number }> = {
  clear: { precip: 5, tmaxF: 78, gustMph: 10 },
  cloudy: { precip: 15, tmaxF: 72, gustMph: 14 },
  rain: { precip: 70, tmaxF: 68, gustMph: 20 },
  storm: { precip: 80, tmaxF: 74, gustMph: 35 },
  snow: { precip: 70, tmaxF: 30, gustMph: 18 },
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A forecast shaped exactly like Open-Meteo's parsed daily row. */
export function injectedForecast(day: string, category: WeatherCategory, precip?: number, tmaxF?: number): DailyForecast {
  const d = DEFAULTS[category];
  const tmax = tmaxF ?? d.tmaxF;
  return { day, weatherCode: CODES[category], precipProbability: precip ?? d.precip, tempMaxF: tmax, tempMinF: tmax - 12, windGustMph: d.gustMph };
}

async function simTrip(runner: ScenarioRunner): Promise<TripRow> {
  const chat = await findChat("sim", runner.need().id);
  if (!chat) throw new Error("atlas hasn't joined this chat yet (add `atlas joins` first)");
  return tripFor(chat.id);
}

export function weatherSimExtension(_session: SimSession): Record<string, Extension> {
  return {
    "trip lock": async (args, runner) => {
      const m = /^(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})$/.exec(args);
      if (!m) throw new Error("usage: trip lock <destination-id> <YYYY-MM-DD start> <YYYY-MM-DD end>");
      const dest = destinationById(m[1]!) ?? findDestination(m[1]!.replace(/-/g, " "));
      if (!dest) throw new Error(`no catalog destination "${m[1]}"`);
      const [start, end] = [m[2]!, m[3]!];
      if (end < start) throw new Error(`trip ends (${end}) before it starts (${start})`);
      const trip = await simTrip(runner);
      const locked = await updateTrip(trip.id, {
        status: "locked",
        destination_id: dest.id,
        destination_name: dest.name,
        latitude: dest.lat,
        longitude: dest.lon,
        start_date: start,
        end_date: end,
        itinerary: draftItinerary(dest, start, end, {}),
        locked_at: now(),
      });
      await startWeatherWatch(locked);
    },

    "weather inject": async (args, runner) => {
      const m = /^(\d{4}-\d{2}-\d{2}|all)\s+(clear|cloudy|rain|storm|snow)(?:\s+(\d{1,3})%?)?(?:\s+(-?\d{1,3})(?:°|f)?)?$/i.exec(args.trim());
      if (!m) throw new Error("usage: weather inject <YYYY-MM-DD|all> <clear|cloudy|rain|storm|snow> [precip%] [tmaxF]");
      const category = m[2]!.toLowerCase() as WeatherCategory;
      const precip = m[3] === undefined ? undefined : Number(m[3]);
      if (precip !== undefined && precip > 100) throw new Error("precip% is 0-100");
      const tmax = m[4] === undefined ? undefined : Number(m[4]);
      const trip = await simTrip(runner);
      const days = m[1]!.toLowerCase() === "all" ? tripDays(trip) : [m[1]!];
      if (days.length === 0) throw new Error("the trip has no dates yet (try `trip lock ...` first)");
      for (const day of days) {
        if (!DAY.test(day)) throw new Error(`bad day ${day}`);
        await q(
          `INSERT INTO weather_overrides (trip_id, day, forecast, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (trip_id, day) DO UPDATE SET forecast = EXCLUDED.forecast, created_at = EXCLUDED.created_at`,
          [trip.id, day, JSON.stringify(injectedForecast(day, category, precip, tmax)), now()],
        );
      }
    },

    "weather clear": async (_args, runner) => {
      const trip = await simTrip(runner);
      await q(`DELETE FROM weather_overrides WHERE trip_id = $1`, [trip.id]);
    },

    "weather check": async (_args, runner) => {
      const trip = await simTrip(runner);
      const key = weatherJobKey(trip.id);
      const moved = await q(`UPDATE jobs SET due_at = $2 WHERE singleton_key = $1 AND done_at IS NULL AND failed_at IS NULL RETURNING id`, [key, now()]);
      if (moved.length === 0) await enqueueJob(WEATHER_JOB, { tripId: trip.id, chatId: trip.chat_id }, { singletonKey: key, dueAt: now() });
      await runner.runJobs();
    },
  };
}
