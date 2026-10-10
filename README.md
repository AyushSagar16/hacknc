# Atlas

**A trip and financial planner that lives in your friend group's iMessage chat.**

Add Atlas's number to the group. It introduces itself, then reads along. It keeps track of what
everyone wants ("cancun is too pricey for me", "i'm vegetarian", "i can't fly after the 14th") and
what everyone can spend, then keeps the plan moving. It proposes three priced options, runs a
poll, sets up a payment plan, splits expenses during the trip and settles up at the end. It only
speaks when it helps, and "atlas stay quiet" mutes it.

- **It reads the conversation.** There are no forms. Each person's preferences and constraints
  are extracted from normal chat, with the words they came from, and resolved deterministically
  (explicit beats implied, newest wins).
- **Budgets come from account data.** Each person gets a Capital One Nessie sandbox customer with
  months of synthetic paychecks, bills and purchases. Their suggested budget is computed from that
  data with a formula Atlas explains in three lines. These are demo spending profiles, never real
  bank accounts.
- **The money runs through Nessie end to end.** Budgets, a payment plan as Nessie bills timed to
  paydays, every trip expense as a Nessie purchase, and settle-up as Nessie transfers after each
  payer confirms.
- **It remembers.** Messages, facts and decisions are stored as Gemini embeddings in Tiger Data
  (pgvector + pgvectorscale) and recalled before every reply, even weeks later.
- **It watches the weather.** When the trip's forecast changes materially, it speaks up with a
  concrete swap ("saturday flipped to rain, want to swap the beach day for the food market tour?").

Money and constraints are deterministic code. The models only do language, and every dollar
figure Atlas shows the group traces to a Nessie call or a labeled estimate.

---

## Quick start (no phones, no keys)

```bash
npm install
```

```bash
npm run db:up
```

```bash
npm test
```

```bash
npm run test:scenarios
```

```bash
npm run sim
```

`npm run sim` opens a group chat in your terminal with Maya, Leo and Priya, and adds Atlas. Type
`maya: hi atlas`, `leo react like atlas.last`, `maya vote 2`, `clock +3d`, `/facts`, `/state`. The
judge console is at http://127.0.0.1:8790. Without a Gemini key, deterministic features
(commands, budgets, polls, money, weather) still work, and model-driven replies are silent. Add
`GEMINI_API_KEY` to `.env` and the simulator uses Gemini live.

## Setup for the real thing

1. **Node 22.9+**, Docker (for local Postgres) or a Tiger Cloud service.
2. `cp .env.example .env` and fill in what you have. **Never commit `.env`.**
3. `npm run doctor` checks everything. It reports which keys are set, never their values.

### Environment variables

| Variable | What for |
|---|---|
| `IMESSAGE_MODE` | `linq` (default), `local`, `cloud` or `sim` |
| `AGENT_NAME` | What friends call it (default `Atlas`) |
| `LINQ_API_KEY` | Linq line key (`npm i -g @linqapp/cli && linq signup`) |
| `LINQ_WEBHOOK_PORT`, `LINQ_WEBHOOK_MODE`, `LINQ_WEBHOOK_SECRET` | Webhook receiver. `relay` mode needs no secret (captured from the CLI); `subscription` mode needs it |
| `PROJECT_ID`, `PROJECT_SECRET` | Photon Spectrum Cloud (`cloud` mode; groups need a dedicated Business line) |
| `DATABASE_URL` | Postgres with TimescaleDB + pgvector (+ pgvectorscale). Empty = local docker |
| `GEMINI_API_KEY` | Gemini for the agent, speak gate, extraction and embeddings |
| `GEMINI_MODEL_AGENT` / `_GATE` / `_EXTRACT` / `GEMINI_EMBED_MODEL` | Model overrides |
| `NESSIE_API_KEY`, `NESSIE_BASE_URL` | Capital One Nessie sandbox |
| `SERPAPI_API_KEY` | Live Google Flights / Hotels prices (optional; otherwise labeled estimates) |
| `ALLOWED_CHATS`, `OPERATOR_HANDLES`, `CONSOLE_PORT`, `DEFAULT_TIMEZONE`, `LOG_LEVEL`, `LOG_FILE` | Operations |

### Database

- **Local:** `npm run db:up` starts `timescale/timescaledb-ha:pg18`, which includes TimescaleDB,
  pgvector and pgvectorscale.
- **Tiger Cloud:** create a free service and set
  `DATABASE_URL=postgres://tsdbadmin:…@….tsdb.cloud.timescale.com:…/tsdb?sslmode=require`.

Migrations run on start (`npm run migrate` to run them alone).

### Nessie

```bash
npm run nessie:probe
```

This creates one fictional probe customer and tries every documented payload shape against the
live API. It fails loudly with Nessie's error body and writes `docs/nessie-findings.md` and
`data/nessie-capabilities.json`, which the app reads at runtime (for example, whether transfers can
name a payee). Nessie data is publicly visible, so Atlas only ever sends fictional persona names.

### The real line (Linq)

1. `npm i -g @linqapp/cli && linq signup` (each teammate their own line), then put the key in `.env`.
2. On a free **Shared** line, register every person by number (`linq contacts add +19195550123`).
   Messages from numbers that aren't registered are held or dropped.
3. `cp demo/roster.example.json demo/roster.json` with your names and phones (optionally pin demo
   personas). `npm run demo -- setup` shows who has texted the line.
4. `npm run demo -- warm` seeds everyone's Nessie demo profile ahead of time and prints their budgets.
5. `npm run live` starts Atlas, opens a `cloudflared` quick tunnel, and creates a Linq webhook
   subscription for every event Atlas handles, native polls included. Every delivery is verified
   with the subscription's signing secret, and the subscription is deleted on exit.
   `npm run live -- --relay` uses the CLI's `linq webhooks listen` relay instead (no tunnel). The CLI
   can't subscribe to poll events, so polls fall back to numbered text and tapback votes.
6. Create a group with your friends and the Atlas number. Atlas introduces itself when Linq
   reports the new chat. To add Atlas to an existing group, Apple may require it to already have
   3 other members.

`npm run ops` has operator commands for a live demo: `failures`, `turns`, `mute`, `weather` (inject
a forecast), and `say` (send as Atlas).

Other lines:
- `IMESSAGE_MODE=local npm start` runs on this Mac's Messages account (a spare Apple ID, with Full
  Disk Access for the terminal). It has no native polls or tapbacks; text fallbacks are automatic.
- `IMESSAGE_MODE=cloud` works with a Photon Business dedicated line. Shared-pool (Free/Pro) lines
  can't do groups.

## How it works

```
Linq webhook ──► signature check ──► durable event log ──► Spectrum (custom "linq" platform)
                                                            │
                     ┌──────────────────────────────────────┘
                     ▼
     inbox (dedupe per chat) ─► per-chat debounce ─► turn:
        intro once → commands & fast paths (votes, confirmations, "i paid 64 for dinner")
        → extraction (Gemini Flash) ∥ addressed check + deterministic hints + speak gate (Flash-Lite)
        → agent (Gemini Flash + tools: proposals, budgets, money, weather, memory)
        → money guard → outbox (stable client GUIDs) ─► Spectrum send with text fallbacks
```

- **Transport:** Spectrum (`spectrum-ts` 12.10.1) with a custom Linq platform, the local and cloud
  iMessage providers, and a simulator platform. Every rich action (tapback, poll, threaded reply,
  link) falls back to plain text when a line can't do it.
- **Pipeline:** each webhook is persisted before it's acknowledged. Messages are deduped per chat,
  bursts are debounced, and a newer message cancels an in-flight turn (its messages carry
  forward). Once a money side effect starts, the turn can't be cancelled. Sends are idempotent
  through stable client GUIDs, and all background work goes through a Postgres job queue with a
  `job_failures` audit table.
- **Memory:** history is scoped per chat, memory per person (Photon's best practice). It's stored
  in `memory_chunks` with a `diskann` index.
- **Time series:** `spend_events` and `weather_snapshots` are hypertables. Two continuous
  aggregates, `trip_spend_daily` (spend so far) and `forecast_drift_daily` (the forecast
  timeline), feed the chat and the judge console.

The full design is in [docs/architecture.md](docs/architecture.md). The step-0 transport
investigation is in [docs/spike-report.md](docs/spike-report.md).

## Models

| Role | Model | Why |
|---|---|---|
| Agent replies + tools | `gemini-3.5-flash-lite` | Fast (about half a second a call), calls tools reliably, and has a free tier |
| Preference extraction | `gemini-3.1-flash-lite` | Structured JSON that matched Flash on our extraction tests; a separate free quota from the agent's |
| Speak gate | `gemini-3.5-flash-lite` | The fastest model; it runs on most messages and fails closed |
| Memory | `gemini-embedding-2`, 768 dims | Recall over months of chat |

Atlas runs on Gemini's free tier, with no billing needed. Free quota is counted per model per day,
and Flash models get only about 20 requests a day each. So the lite models do the everyday work, and
`GEMINI_FALLBACK_MODELS` (`gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemini-3-flash-preview`,
`gemini-3.8-flash`) takes over as each one runs out. A model that's out of quota or overloaded is
skipped for a while: 30 minutes for a daily quota, or the retry delay Google returns for a
per-minute one. Atlas also avoids spending calls it doesn't need:
- Laughter and acks ("lol", "😂", "ok") skip the models entirely.
- A tool that posts its own message ends the agent's turn.
- Startup pings only the primary models.

To see your project's exact limits, open Google AI Studio's rate-limit page.

## Testing

- `npm test` runs unit and integration tests against a real Postgres, with a fake Linq API, a fake
  Nessie that models the quirks observed in 2026, fake SerpApi/Open-Meteo, and scripted model
  answers.
- `npm run test:scenarios` plays every `test/scenarios/*.chat` conversation through the real
  pipeline on the simulator, with scripted model answers, so it runs offline and deterministically.
  `npm run test:scenarios -- --live` runs them against real Gemini, where the scripted lines are
  ignored and wording can vary.
- `npm run typecheck`.

## Project layout

```
src/transport   Linq platform + webhook server, simulator platform, inbound/outbound mapping
src/pipeline    inbox, debounce/cancel/carry-forward, outbox, jobs + job_failures
src/agent       brain (turn order), speak gate, agent loop, commands, money guard, features/*
src/profile     extraction schema, Gemini extraction, deterministic aggregation, group view
src/memory      embedding writer and scoped, privacy-filtered recall
src/money       cents, splits, settle-up (exact minimum transfers), budget engine, payment plans
src/nessie      client (cache, audit, circuit breaker), personas, seeding, ledger, budgets
src/trips       catalog, constraints, filter, scoring, live pricing, polls, ledger, itinerary
src/weather     Open-Meteo client, classification, change detection, cadence, swaps
src/console     the judge console
scripts         sim, e2e, live, doctor, demo, ops, nessie-probe, migrate
```

## Credits

Atlas adapts code and ideas from **[scout](https://github.com/ethanyanghq/scout) by Ethan Yang**,
used and adapted **with the author's explicit permission**. That includes the Linq platform and
simulator foundations, the two-stage speak gate, the `.chat` scenario format, vote parsing, and the
expense-split and settle-up math. The upstream repository has no license file; the author's
permission is the basis for this use. Adapted code lives in its own commits titled
`import from scout (used with author permission)`, and each adapted file names its source in a
header. The full list is in [NOTICE](NOTICE). Thank you, Ethan.

Also built on:
- [Photon Spectrum](https://photon.codes/docs/spectrum-ts)
- [Linq](https://linqapp.com)
- [Capital One Nessie](https://nessieisreal.com) (synthetic sandbox data)
- [Tiger Data](https://www.tigerdata.com) (TimescaleDB, pgvector, pgvectorscale)
- [Google Gemini](https://ai.google.dev)
- [SerpApi](https://serpapi.com)
- Weather data by [Open-Meteo](https://open-meteo.com), licensed CC BY 4.0
