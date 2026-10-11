# Plan: bank-connect onboarding, trip stages, trip fund

Agreed with the product owner on 2026-10-10. This is the build spec; each section names its owner
workstream so parallel work doesn't collide.

## Ground rules (all workstreams)

- **The chat never mentions Nessie, sandbox, demo, synthetic, simulated, fake or test money.** That
  covers user-facing strings, `src/agent/prompts/*.md`, and every tool `description` the model sees.
  Atlas treats connected accounts and the trip fund as real money ("your capital one", "trip fund",
  "booked ✓"). Nessie is the backend only. Code comments, README and docs may say Nessie openly.
- Money stays deterministic code. Every `$` the model writes must be registered (money guard,
  `src/agent/figures.ts`). Individual budgets are **private by default**: the group only ever sees
  pooled figures; a person can say "share my budget" to opt in, and see their own in a DM.
- Everything must work offline: no API key → deterministic fallback (Nessie already has one;
  SerpApi uses fixtures in `test/fixtures/serpapi/`). Tests never hit the network.
- Before committing: `npm run typecheck`, `npm test`, `npm run test:scenarios` all green. Add a
  `test/scenarios/*.chat` for each new behaviour (format: `src/sim/script.ts:9-23`).
- Migration numbers are reserved per workstream (below). Plain SQL, filename order.

## 1. Wording cleanup + realistic seed data — workstream A

- Remove demo/sandbox/Nessie wording from: `src/agent/features/budgets.ts`, `money.ts`,
  `src/agent/prompts/system.md` (lines ~85-86), help text in `brain.ts` (~410), `src/console/server.ts`
  labels may keep "Nessie" (operator-only). **Do not touch `introLines` in brain.ts** (workstream B owns it).
- Budgets are described as "based on your last few months of spending" from "your connected account".
- `src/nessie/personas.ts`: realistic merchant/bill names ("Verizon Wireless", not "Sandbox
  Wireless"), real-looking streets, accounts named "Checking"/"Savings"/"Quicksilver" etc.;
  customer = person's real first name + a generated plausible last name (not "Atlasdemo").
- Private-by-default budgets (flip the default; keep "keep my budget private"; add "share my budget").
- Update affected tests and scenarios. README/docs: keep Nessie explicit (it's what judges score),
  but describe the chat as showing it as a connected Capital One account.

## 2. Bank-connect onboarding — workstream B (migration 010)

Flow:
1. Intro (rewrite `introLines` in `src/agent/brain.ts`): no demo wording; ends asking
   "want to connect your capital one so i can plan around real budgets?" Late joiners' welcome asks the same.
2. A person says yes (deterministic fast path + agent tool `send_connect_link`) → Atlas posts in the
   group "here's yours <name> 🔒" + a link action to `${SITE_BASE_URL}/connect/<token>`.
3. Token = `base64url(json).base64url(hmacSha256(CONNECT_SECRET, json))`, payload
   `{ v:1, p: personId, c: chatId, n: firstName, cb: atlasPublicBaseUrl, exp: epochSeconds }` (48 h).
   `atlasPublicBaseUrl` is Atlas's current public URL (the cloudflared tunnel in `scripts/live.ts`;
   make it available to the app, e.g. config `PUBLIC_BASE_URL` set at runtime by live.ts).
4. Web: `web/app/connect/[token]/page.tsx` — Capital One–styled consent screen ("Connecting as Maya",
   accounts to share, Connect button) → server action/route verifies the signature + expiry, POSTs
   `{token}` to `${cb}/connect-callback` with header `x-atlas-signature` = HMAC of the body.
   States: connected ✓, expired/invalid ("ask Atlas for a new link"), Atlas unreachable.
5. Atlas `POST /connect-callback` (same HTTP server as `/linq-events`): verify signature + expiry,
   idempotently mark connected, then seed that person's Nessie customer (existing `ensureLink` /
   `nessie.link` job path) and compute their budget, then say in the group "<name>'s connected ✓".
   Budgets are no longer linked for everyone on join — only on connect.
6. Decline / no connect: Atlas asks that person for a rough budget in chat (stored as a stated budget,
   `set_my_budget` already exists); one nudge after ~1 day via the job queue.
7. Sim/tests: a scenario directive to simulate the click (e.g. `maya connects`) calling the same
   handler. Env: `CONNECT_SECRET`, `PUBLIC_BASE_URL` in `src/config.ts` + `.env.example`
   (+ `web/.env.example` for `CONNECT_SECRET`).

Table `bank_connections(person_id, chat_id, status offered|link_sent|connected|declined,
link_sent_at, connected_at, nudged_at, …)`.

## 3-5. Trip stages, locations, availability, travel — workstream C (migration 011)

- **Stages** per trip: `location`, `dates`, `travel`, `stay`, `food_activities`; each
  `open|in_progress|decided`. Atlas nudges toward the earliest undecided stage, but still records
  info given out of order. Reopening a stage resets later dependent stages (location → all;
  dates → travel, stay, food). Expose stage state to the agent context and the site snapshot.
- **Location**: catalog (`data/destinations.json`) for proposals + poll as today; when the group names
  an off-catalog place, geocode it with the keyless Open-Meteo geocoding API
  (`https://geocoding-api.open-meteo.com/v1/search`) and lock it with lat/lon; pricing for off-catalog
  places comes from live SerpApi (fixtures offline).
- **Availability**: deterministic overlap from `date_window` / `blackout` facts and trip length:
  windows that work for everyone (else most people, naming conflicts). One clear winner → propose for
  👍; 2-3 candidates → poll. Ask people who haven't given dates.
- **Travel**: after location+dates decided, persist a per-person plan (`travel_plans`: mode
  drive|fly, origin, est. cost, hours, carpool group, overridden flag). Uses existing
  `src/trips/estimate.ts`. One rundown message; flights linked to Google Flights; carpool suggestion
  for drivers from the same area; "i'll drive" overrides. Travel is personal cost (each person's own
  budget), not the trip fund.
- Migration 011 also adds `trips.stay jsonb` (shape below) so workstreams D and E can rely on it:
  `{ name, kind: "hotel"|"rental", address, lat, lon, check_in, check_out, total_cents,
  per_person_night_cents, rating, link, booked_at }`.

## 6 + 8. Trip fund, stay booking, combined settle-up — workstream D (migration 012)

- **Stay**: once dates are decided, SerpApi google_hotels (+ `vacation_rentals=true`) for the
  destination/dates, filter to pooled budget and beds for the group, propose 3 named options
  (price/person/night, rating, link) → poll → winner stored in `trips.stay`, stage `stay` decided,
  Atlas says "booked ✓".
- **Trip fund**: a Nessie account for the trip (owned by a trip customer). Target = stay total +
  anything the group marks shared ("put the boat on the fund"). Each person's share follows
  `split_mode` (default equal). Contributions = installments on each payday before a deposit deadline
  (~2 weeks before the trip), executed automatically as Nessie transfers checking → fund (replaces the
  current bills-based payment plan). The stay booking is a fund purchase; booked with a balance due
  until the fund reaches target. Status line: "fund's at $840 / $1,200, leo's next $90 goes in friday".
- **Tab**: existing Splitwise-style `log_expense` (splits, "i got leo's ticket" = split_among [leo],
  itemized). Make sure buying for someone else works.
- **Combined settle-up** at trip end: net = (fund contributions − share of fund spend) + (paid for
  others − others paid for you). Fund leftover refunded pro-rata to contributions; shortfall folded
  into the settle-up. One minimal-transfer list, each executed as a Nessie transfer after the payer
  confirms (existing confirm flow).

## 7. Food & activities — workstream E (migration 013 if needed)

- After the stay is booked (`trips.stay` lat/lon; fall back to destination lat/lon), SerpApi
  `google_maps` search around it for restaurants and things to do, honouring dietary + activity
  facts. Post a shortlist (~5 food, ~5 activities: rating, price level, distance). People react or
  say "add X" → saved and written into the itinerary/trip page. Stage `food_activities` progresses.
  Fixtures for tests.

## 9. Showcase — workstream F

- Trip page (`web/app/t/[id]`): "Trip fund" panel labelled Capital One — target, collected, progress
  bar, fund transactions (first names only, never budgets). Extend `src/site/snapshot.ts`,
  `src/site/types.ts` and its copy `web/lib/types.ts`, plus the Supabase site migration.
  Also show the stage progress bar.
- Operator console (`src/console/server.ts`): Nessie view — customers, accounts, live balances,
  recent `nessie_calls` (endpoint, status, latency).
