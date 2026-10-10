// Operator commands against the running Atlas's database (it picks up queued work within ~1s).
//   npm run ops -- failures            last job failures
//   npm run ops -- turns <chatId>      recent routing decisions
//   npm run ops -- mute <chatId> | unmute <chatId>
//   npm run ops -- weather <chatId> <YYYY-MM-DD|all> <clear|cloudy|rain|storm|snow> [precip%] [tmaxF]
//   npm run ops -- say <chatId> <text> send a message as Atlas (recovery during a live demo)
import { loadConfig, setConfig } from "../src/config.ts";
import { now } from "../src/clock.ts";
import { closeDb, one, q } from "../src/db/pool.ts";
import { enqueueJob, rescheduleSingleton } from "../src/pipeline/jobs.ts";
import { injectedForecast } from "../src/sim/weatherExtension.ts";
import { tripDays, weatherJobKey, WEATHER_JOB } from "../src/agent/features/weather.ts";
import type { TripRow } from "../src/trips/state.ts";

setConfig(loadConfig());
const [cmd, ...rest] = process.argv.slice(2);
const chatId = Number(rest[0]);

switch (cmd) {
  case "failures":
    console.table(await q(`SELECT created_at, queue, job_id, chat_id, left(error, 120) AS error FROM job_failures ORDER BY id DESC LIMIT 20`));
    break;
  case "turns":
    console.table(await q(`SELECT id, started_at, route, addressed, gate_decision, left(gate_reason, 60) AS reason, latency_ms FROM turns WHERE chat_id = $1 ORDER BY id DESC LIMIT 20`, [chatId]));
    break;
  case "mute":
  case "unmute":
    await q(`UPDATE chats SET quiet_mode = $2 WHERE id = $1`, [chatId, cmd === "mute"]);
    console.log(`chat ${chatId} ${cmd}d`);
    break;
  case "weather": {
    const [, day, category, precip, tmax] = rest;
    const trip = await one<TripRow>(`SELECT * FROM trips WHERE chat_id = $1`, [chatId]);
    if (!trip?.start_date) throw new Error("that chat has no trip with dates");
    const days = day === "all" ? tripDays(trip) : [day!];
    for (const d of days) {
      const f = injectedForecast(d, category as never, precip ? Number(precip) : undefined, tmax ? Number(tmax) : undefined);
      await q(`INSERT INTO weather_overrides (trip_id, day, forecast, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (trip_id, day) DO UPDATE SET forecast = EXCLUDED.forecast, created_at = EXCLUDED.created_at`, [trip.id, d, JSON.stringify(f), now()]);
    }
    await rescheduleSingleton(weatherJobKey(trip.id), now());
    await enqueueJob(WEATHER_JOB, { tripId: trip.id, chatId }, { singletonKey: weatherJobKey(trip.id) });
    console.log(`injected ${category} for ${days.join(", ")}; the weather check runs within a second`);
    break;
  }
  case "say": {
    const text = rest.slice(1).join(" ");
    if (!text) throw new Error("usage: ops say <chatId> <text>");
    const guid = `ops-${Date.now()}-0`;
    await q(`INSERT INTO outbox (chat_id, idx, client_guid, action, created_at) VALUES ($1, 0, $2, $3, $4)`, [chatId, guid, JSON.stringify({ type: "say", text }), now()]);
    await enqueueJob("outbox.flush", { chatId }, { singletonKey: `outbox:${chatId}` });
    console.log("queued");
    break;
  }
  default:
    console.log("usage: npm run ops -- failures | turns <chatId> | mute <chatId> | unmute <chatId> | weather <chatId> <day|all> <category> [precip] [tmax] | say <chatId> <text>");
}
await closeDb();
