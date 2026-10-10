# Architecture

Atlas is one TypeScript process (Node 22, ESM, `tsx`) on one Postgres database (Tiger Data:
TimescaleDB + pgvector + pgvectorscale). Gemini only does language; money, constraints, polls and
schedules are deterministic code.

## Components

| Component | Files | Responsibility |
|---|---|---|
| Transport | `src/transport/*` | Spectrum app per `IMESSAGE_MODE`. The custom Linq platform (webhook server, signature check, durable event log, ordered queue, send dispatcher incl. native polls). The simulator platform. Normalized inbound events. The outbound action model with text fallbacks |
| Pipeline | `src/pipeline/*` | Inbox (dedupe per chat); per-chat debounce (2.5 s quiet window, 8 s cap); in-flight cancellation and carry-forward; outbox with stable client GUIDs and resume; Postgres job runner on the app clock; `job_failures` |
| Brain | `src/agent/brain.ts` | One turn in a fixed order (below). Composes feature modules |
| Features | `src/agent/features/*` | planning, budgets, proposals, money, weather, memory: each adds tools, fast paths, commands, hints, situation sections, money-guard figures, jobs and lifecycle hooks |
| Profile | `src/profile/*` | Fact schema, Gemini extraction (validated), deterministic aggregation, group view |
| Money | `src/money/*`, `src/trips/ledger.ts` | Cents, splits, exact minimum settle-up, budget engine, paycheck cadence and payment plans, trip ledger |
| Nessie | `src/nessie/*` | Client (https, audit, last-good cache, circuit breaker), probe-driven capabilities, personas, resumable seeding, ledger replay, budgets |
| Trips | `src/trips/*` | Catalog (41 destinations, 105 home airports), constraints, hard filter, scoring, SerpApi pricing with cache and fallback, votes, itinerary, booking links |
| Weather | `src/weather/*`, `features/weather.ts` | Open-Meteo, classification, change detection, cadence, cooldown, swaps |
| Memory | `src/memory/*`, `features/memory.ts` | Embedding writer, scoped and privacy-filtered recall with recency rerank |
| Console | `src/console/server.ts` | Localhost judge view of all of the above |

## Data model (Postgres)

- **Conversation:** `people`, `chats`, `chat_members`, `messages` (history per chat; unclaimed
  inbound rows are the batch queue), `turns`, `outbox`, `webhook_events`.
- **Jobs:** `jobs` (`SKIP LOCKED`, due times from the app clock, recurring via reschedule),
  `job_failures` (30-day retention), `llm_traces`.
- **Memory per person:** `facts` (each with quote, source message, confidence, visibility,
  `superseded_by`), `asks` (ask-once).
- **Trip:** `trips`, `proposals`, `polls`, `votes`, `confirmations`.
- **Money:** `budgets` (formula inputs + Nessie ids + visibility), `installments` (Nessie bill ids),
  `expenses` (exact cents, idempotency key, Nessie purchase id), `settlements` (Nessie transfer and
  deposit ids).
- **Nessie:** `nessie_links`, `nessie_merchants`, `nessie_cache`, `nessie_calls`.
- **Tiger Data features:**
  - `memory_chunks`: `vector(768)` with a `diskann` index (HNSW if pgvectorscale is missing)
  - `spend_events` and `weather_snapshots`: hypertables
  - `trip_spend_daily` and `forecast_drift_daily`: continuous aggregates with `materialized_only = false`

## One full trip, message by message

1. A friend adds the Atlas number to a group. Linq sends `participant.added` (or `chat.created`),
   which goes through the signature check, `webhook_events`, the Spectrum `addMember` record and
   the inbox. That runs a turn and sends the **intro** once. Members Atlas hasn't heard from are
   learned with `GET /chats/{id}`. Each new person gets a **Nessie link job**, which seeds a
   persona-varied demo profile.
2. Friends talk. Each burst becomes one turn. **Extraction** runs on every batch in parallel with
   the **speak gate**, so Atlas learns even when it stays silent. Facts land with quotes; the
   aggregator resolves the current truth.
3. Atlas asks for missing dates and home cities **once per person** (`asks`). Once a majority has
   shared, it moves on.
4. "what's our budget" runs deterministically: budgets from each person's Nessie data, the formula
   in three lines, "based on demo spending profiles", the pooled range. Private budgets only appear
   pooled.
5. "atlas give us some options" goes through constraints, the hard filter, scoring, live pricing
   for the top five, three options with per-person breakdowns, and a **native poll**.
6. Votes come in (native, tapback or text). A majority **locks** the trip: destination, dates,
   itinerary and booking links. That fires `onTripLocked`: a **payment plan** (Nessie bills on each
   person's paydays), a recurring **weather.check** job, and a decision memory.
7. During the trip, "i paid 64 for dinner" becomes a Nessie purchase on the payer's account, a
   ledger row and a spend event. Disputes from anyone but the payer wait for the payer's "yes".
8. "settle up" proposes the fewest transfers. Each payer's "confirm" executes a Nessie transfer
   (plus a payee-side deposit when this Nessie can't name a payee). When the last one is done, the
   trip is marked done.

## Turn order and the speak gate

```
intro (once per chat)
for each message in the batch:
  fast paths (no model): poll votes · tapback votes · confirmations ("yes"/"confirm") · clean expense statements
  commands (no model): stay quiet · talk again · summarize · help · budgets · privacy · set budget · settle up · balances · options
remaining messages:
  addressed?  @atlas / "hey atlas" / starts with "atlas" (not "atlas seems…") / "…, atlas?" /
              threaded reply to an Atlas message id / answer to Atlas's open question (≤3 msgs, 15 min, aimed person only)
  quiet mode and not addressed → stop
  not addressed → speak gate (gemini-3.5-flash-lite, temp 0, 3.5 s timeout, JSON {decision, reason}, fails closed)
                  input: last 12 messages, stage, facts, deterministic hints (stuck poll, date conflict,
                  majority shared, installments due, trip over), minutes since Atlas spoke, unprompted count
  extraction result: a fresh disagreement can trigger one unprompted line (≤12 unprompted/hour)
  agent (gemini-3.5-flash-lite, ≤4 tool rounds): stateless situation (trip, resolved profiles with quotes,
         feature sections, allowed figures, recalled memories, last 30 messages, new messages)
  money guard: every $ figure must match a registered figure the audience may see, or the text is dropped
outbox → ordered sends with client GUIDs → text fallbacks

follow-up (no new messages): after a human message Atlas didn't answer, a `chat.nudge` job is
  scheduled NUDGE_IDLE_SECONDS out (pushed back by every new message). If the group is still quiet
  and the last word is still human, the agent gets the situation plus "the chat went quiet, take the
  next step". The same check runs on startup for groups that were mid-conversation. At most one
  follow-up per unanswered message; quiet mode and the unprompted cap apply.
```

The gate prompt is in `src/agent/prompts/speak-gate.md`, the agent's in `src/agent/prompts/system.md`
and extraction's in `src/agent/prompts/extract.md`.

## Memory design

- **Write:** after each turn a `memory.embed` job embeds message windows (≤2,400 chars,
  speaker-labeled, pure acknowledgements skipped) and resolved facts (budget amounts omitted).
  Decisions are written when a trip locks. Rows record chat, person, kind, visibility and source
  message ids, and writes are idempotent.
- **Read:** before every agent reply, the query is the new messages. Candidates are this chat's
  history and decisions plus current members' facts from any chat, filtered by visibility (private
  only in that person's DM). They come from `ORDER BY embedding <=> $q LIMIT 50` over `diskann`
  with search-list and rescore settings tuned so the top hits match an exact scan. They're then
  reranked by `similarity × (0.85 + 0.15·e^(−age/14d))`, keeping the top 8 and excluding the last
  6 hours (already in context).

## Reliability rules

- Every webhook is persisted before the 200. Unprocessed events replay on boot; anything older
  than 5 minutes is extraction-only, never answered.
- Inbound can't die: per-record try/catch, all-optional `message.schema` extras, and a rebuild if
  `app.messages` ever ends.
- Money side effects mark the turn non-cancellable and are keyed by source message, so redeliveries
  and retries never double-log or double-send.
- Nessie: last-good cache for reads, circuit breaker, offline demo profiles when no key is set,
  and every call audited.
- SerpApi failures fall back to labeled estimates per cost component. Open-Meteo failures retry
  with backoff, and rehearsal overrides skip the network.
- Gemini failures: the gate fails closed, extraction retries next turn, the agent says it glitched
  only when it was explicitly addressed, and commands and money keep working without a key.

## Track map

| Capability | Tracks | Evidence in a demo |
|---|---|---|
| Linq platform, native polls, tapbacks, fallbacks | Photon, General | Real group on phones; native poll; console shows routing |
| Presence + speak gate | Gemini, Photon, General | Quiet through banter, jumps in on a disagreement; console lists each gate decision and reason |
| Extraction + profiles | Gemini, General | "cancun is too pricey for me" shows up as a veto with its quote and confidence |
| Nessie linking + budgets | Capital One | Customers, accounts, deposits, bills, withdrawals, purchases, merchants created live; budgets with formula and customer ids |
| Proposals + polls | General, Photon | Three options with live fares or labeled estimates; native poll; majority locks |
| Payment plan, expenses, settle-up | Capital One | Bills on paydays; "i paid 64" becomes a Nessie purchase; settle-up becomes Nessie transfers after "confirm" |
| Memory + aggregates | Tiger Data, Gemini | Recall weeks later; diskann; `trip_spend_daily` and `forecast_drift_daily` in chat and console |
| Weather watch | General | Injected or real forecast flip leads to a swap offer and poll |
| Write-up | DEV challenge | `docs/dev-post.md` |
| Domain | .Tech | Landing page on a .tech domain |
