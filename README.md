# Atlas

**A trip and financial planner that lives in your friend group's iMessage chat.**

Add Atlas's number to the group. It introduces itself, then reads along. It keeps track of what
everyone wants ("cancun is too pricey for me", "i'm vegetarian", "i can't fly after the 14th") and
what everyone can spend, then keeps the plan moving. It proposes priced options that fit the
group's vibe and limits, runs a poll, sets up a payment plan, splits expenses during the trip and
settles up at the end. It chimes in whenever the trip or money comes up and stays out of banter.
When the group goes quiet on an unanswered message, it follows up with the next step, and when most
of the group has voted it names who hasn't ("skip" decides with the votes in). "atlas stay quiet"
mutes it.

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
- **It remembers.** Messages and decisions are stored in Tiger Data and recalled before every reply,
  even weeks later, with hybrid search: BM25 (`pg_textsearch`) and Gemini embeddings on a
  pgvectorscale `diskann` index, fused with reciprocal rank fusion. It also remembers its own words
  (an `atlas_log` hypertable), so it doesn't repeat a nudge or re-ask someone.
- **It looks things up.** Things to do, food, events and school-break dates come from the live web,
  and every item it posts has to appear in a page it actually read. Weather is a real forecast within
  two weeks and three-year climatology beyond that.
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
| `GEMINI_API_KEY` | Gemini for the agent, speak gate, extraction and embeddings. Several keys, comma-separated, are load-balanced (see below) |
| `GEMINI_MODEL_AGENT` / `_GATE` / `_EXTRACT` / `GEMINI_EMBED_MODEL` | Model overrides |
| `NESSIE_API_KEY`, `NESSIE_BASE_URL` | Capital One Nessie sandbox |
| `SERPAPI_API_KEY` | Live Google Flights / Hotels prices (optional; otherwise labeled estimates) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SITE_BASE_URL` | Trip pages: where Atlas publishes each trip, and where `web/` is deployed. Leave empty to turn trip pages off |
| `CONNECT_SECRET`, `PUBLIC_BASE_URL` | Bank connect: `CONNECT_SECRET` signs connect links and the site's callback (same value in `web/.env`); `PUBLIC_BASE_URL` is where the site calls Atlas back (`npm run live` sets it to its tunnel). See [Bank connect](#bank-connect-onboarding) |
| `NUDGE_IDLE_SECONDS` | How long a group must be quiet after an unanswered message before Atlas follows up (default 150 on a real line, off in the simulator; 0 = off) |
| `PACING`, `PACE_BASE_MS`, `PACE_MS_PER_CHAR`, `PACE_MIN_MS`, `PACE_MAX_MS`, `PACE_FIRST_MAX_MS` | Typing indicator and a pause per bubble scaled to its length (`PACING=off` sends back to back) |
| `ADDRESSED_DEBOUNCE_MS` | Quiet window before replying to a message that names Atlas (default 1500; others wait 2.5 s) |
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

### Trip pages (web/)

Every trip gets its own page at an unguessable URL (`/t/<uuid>`) with the plan, the day-by-day
itinerary, sourced research and the trip's group chat. Atlas writes the page itself: the agent
sends the itinerary and summary as structured JSON (`update_itinerary`, `set_trip_summary`),
validated before it's saved. It posts the link, deep-linked to the section that changed, when a
trip starts, gets a plan, gets a weather swap or finishes research.
iMessage builds each section's preview card from that page's tags and image. A chat can plan
several trips; `/g/<uuid>` lists them.

1. Create a Supabase project and apply `supabase/migrations` (`supabase link` then
   `supabase db push`, or paste the SQL into the SQL editor). RLS is on with no policies, so only
   the service-role key can read or write.
2. Deploy `web/` to Vercel (project root `web`) with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
   `NEXT_PUBLIC_SITE_URL` (see `web/.env.example`).
3. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SITE_BASE_URL` in `.env`. `npm run doctor`
   checks them.

Locally: `supabase start`, put the local keys in `web/.env.local`, then run `npm run web:dev` and
`npm run site:seed` (it publishes a made-up trip and prints its URLs). Pages show first names only,
never phone numbers, and nothing about budgets or balances. Private chats are never published.

### Bank connect onboarding

Nobody gets a Nessie customer just for being in the group. The intro ends with "want to connect
your capital one so i can plan around real budgets?" (late joiners are asked in their welcome).

1. "yes" (or "connect me", anytime) → Atlas posts "here's yours maya 🔒" and a link to
   `SITE_BASE_URL/connect/<token>`. The token is `base64url(json).base64url(HMAC-SHA256(CONNECT_SECRET, json))`
   over `{v, p: person, c: chat, n: first name, cb: Atlas's public URL, exp}`, valid 48 hours. Fuzzier
   asks go through the agent's `send_connect_link` tool.
2. The consent page (`web/app/connect/[token]`, styled as a Capital One screen: read-only balances and
   the last 3 months of transactions) verifies the token, and Connect POSTs `{"token"}` to
   `${cb}/connect-callback` with `x-atlas-signature` = HMAC of the body.
3. Atlas's webhook server (`LINQ_WEBHOOK_PORT`, same as `/linq-events`) checks both signatures and the
   expiry, marks the person connected (idempotent), and a `connect.complete` job links and seeds their
   Nessie customer, computes their budget and says "maya's connected ✓" in the group. No figure:
   budgets stay private.
4. "no"/"nah" → Atlas asks for a rough number instead ("like 600" sets it). Whoever has neither
   connected nor given a budget gets one nudge about a day later (`connect.nudge` job).

State lives in `bank_connections` (migration 010). In the chat it's always "your capital one"; Nessie
is the backend. To try it end to end: set the same `CONNECT_SECRET` in `.env` and `web/.env.local`,
point `SITE_BASE_URL` at the deployed site (or `http://localhost:3000` with `npm run web:dev`), and run
`npm run live`. In the simulator, `maya connects` in a `.chat` script (or the REPL) runs the same
callback handler; without `CONNECT_SECRET` the simulator signs with a fixed dev secret that
`npm run web:dev` also accepts, so sim links open locally.

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
  in `memory_chunks` with a `diskann` vector index and a BM25 index, queried together in one SQL
  statement. Atlas's own messages go to the `atlas_log` hypertable, which feeds a "what you already
  said" section and a `pg_trgm` guard against repeated nudges. See [docs/memory-research.md](docs/memory-research.md).
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
per-minute one. With several keys in `GEMINI_API_KEY` (comma-separated, each from a different Google
Cloud project, since quota is per project), calls rotate across the keys and a quota error benches
the model on that key only, so the other keys keep the preferred model going before Atlas falls
back to the next model. Overload, timeouts and missing models are Google's side and bench the model
on every key; a rejected key is skipped for an hour. Atlas also avoids spending calls it doesn't need:
- Laughter and acks ("lol", "😂", "ok") skip the models entirely, and so does off-topic chatter with
  no trip or money words ("did anyone watch the game").
- A trip or money question to the room, an objection or a change of mind skips the gate and goes
  straight to the agent; if the gate model is out of quota, a deterministic fallback decides.
- Commands, votes, poll reminders and money never wait on a model.
- A one-word memory query is a BM25 search with no embedding call.
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
- `npx tsx --env-file-if-exists=.env scripts/e2e.ts --live --dir test/live` replays every bug found
  in a real chat or a persona QA run (`test/live/*.chat`) against real Gemini, with wording-tolerant
  checks (regexes, SQL, silence). It spends free-tier quota, so run it on its own.
- `npx tsx --env-file-if-exists=.env scripts/persona-server.ts --port 8801 --members maya,leo,priya`
  runs a simulated group chat (fake phone numbers, a throwaway database, live Gemini) behind a small
  localhost HTTP API (`POST /step`, `GET /wait`, `/transcript`, `/state`), so a person, a script or
  an agent can play the whole group. Start several on different ports one after another.
- `npm run typecheck`.

## Project layout

```
src/transport   Linq platform + webhook server, simulator platform, inbound/outbound mapping
src/pipeline    inbox, debounce/cancel/carry-forward, outbox, jobs + job_failures
src/agent       brain (turn order), speak gate, agent loop, commands, money guard, features/*
src/profile     extraction schema, Gemini extraction, deterministic aggregation, group view
src/memory      embedding writer, hybrid BM25 + vector recall, atlas_log (Atlas's own words)
src/search      web search (results + pages read, every item verified against the source)
src/money       cents, splits, settle-up (exact minimum transfers), budget engine, payment plans
src/nessie      client (cache, audit, circuit breaker), personas, seeding, ledger, budgets
src/trips       catalog, constraints, filter, scoring, live pricing, polls, ledger, itinerary
src/weather     Open-Meteo client, classification, change detection, cadence, swaps
src/site        trip pages: snapshot (the privacy boundary), Supabase store, publish + links
src/console     the judge console
web             the trip-page site (Next.js on Vercel, reads Supabase server-side)
supabase        the site's Supabase schema
scripts         sim, e2e, live, persona-server, doctor, demo, ops, nessie-probe, migrate, site-seed
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
