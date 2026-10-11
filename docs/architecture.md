# Architecture

Atlas is one TypeScript process (Node 22, ESM, `tsx`) on one Postgres database (Tiger Data:
TimescaleDB + pgvector + pgvectorscale). Gemini only does language; money, constraints, polls and
schedules are deterministic code.

## Components

| Component | Files | Responsibility |
|---|---|---|
| Transport | `src/transport/*` | Spectrum app per `IMESSAGE_MODE`. The custom Linq platform (webhook server, signature check, durable event log, ordered queue, send dispatcher incl. native polls). The simulator platform. Normalized inbound events. The outbound action model with text fallbacks |
| Pipeline | `src/pipeline/*` | Inbox (dedupe per chat); per-chat debounce (2.5 s quiet window, 1.5 s when Atlas is named, 8 s cap); typing indicator and length-scaled pauses between bubbles; in-flight cancellation and carry-forward; outbox with stable client GUIDs and resume; Postgres job runner on the app clock; `job_failures` |
| Brain | `src/agent/brain.ts` | One turn in a fixed order (below). Composes feature modules |
| Features | `src/agent/features/*` | trips, planning, budgets, proposals, money, weather, memory, self-memory, search, presence, research, site: each adds tools, fast paths, commands, hints, situation sections, money-guard figures, jobs and lifecycle hooks |
| Profile | `src/profile/*` | Fact schema, Gemini extraction (validated; who reported each fact; refusal words for vetoes, numbers for ceilings; "same dates" resolved), deterministic aggregation, group view |
| Money | `src/money/*`, `src/trips/ledger.ts` | Cents, splits, exact minimum settle-up, budget engine, paycheck cadence and payment plans, trip ledger, trip fund (`src/money/fund.ts`, `src/trips/fund.ts`) |
| Nessie | `src/nessie/*` | Client (https, audit, last-good cache, circuit breaker), probe-driven capabilities, personas, resumable seeding, ledger replay, budgets |
| Trips | `src/trips/*` | Catalog (destinations with vibe tags incl. `holiday`, 105 home airports), per-person drive times, constraints (no-fly and max-drive enforced per person), hard filter, scoring with a required vibe, SerpApi pricing with cache and fallback, votes (ties don't lock), itinerary (no repeats, seasonal), booking links, food & activities near the stay (SerpApi google_maps, `trips/nearby.ts`, `features/places.ts`: dietary-aware shortlist, picks onto the itinerary) |
| Weather | `src/weather/*`, `features/weather.ts` | Open-Meteo forecast and 3-year climatology (`get_weather`), classification, change detection, cadence, cooldown, swaps |
| Search | `src/search/*`, `features/search.ts` | `web_search`: result pages read in code, Gemini answers from them, every posted item verified against the source; Wikivoyage fallback |
| Memory | `src/memory/*`, `features/memory.ts` | Embedding writer, hybrid BM25 + diskann recall (RRF) with recency and importance rerank, `atlas_log` of Atlas's own words |
| Console | `src/console/server.ts` | Localhost judge view of all of the above |
| Trip pages | `src/site/*`, `features/site.ts`, `web/`, `supabase/` | Per-trip snapshot (first names only, no money), Supabase store, publish-then-link; the Next.js site that renders each section and its iMessage preview |

## Data model (Postgres)

- **Conversation:** `people`, `chats`, `chat_members`, `messages` (history per chat; unclaimed
  inbound rows are the batch queue), `turns`, `outbox`, `webhook_events`.
- **Jobs:** `jobs` (`SKIP LOCKED`, due times from the app clock, recurring via reschedule),
  `job_failures` (30-day retention), `llm_traces`.
- **Memory per person:** `facts` (each with quote, source message, confidence, visibility,
  `superseded_by`), `asks` (ask-once).
- **Trip:** `trips` (several per chat; `chats.focus_trip_id` is the one being planned, `public_id`
  is the page URL), `proposals`, `polls` (one open per kind per trip), `votes`, `confirmations`,
  `trip_research` (one note per topic from the web search, with its source). `messages.trip_id` and trip-scoped
  `facts.trip_id` (destination, date window, trip length, budget talk) record which trip they were
  about; facts about the person carry across trips.
- **Money:** `budgets` (formula inputs + Nessie ids + visibility), `installments` (legacy Nessie bill ids), `trip_funds` / `fund_items` / `fund_txns` (the trip
  fund: its Nessie customer and account, what it pays for, every contribution, refund and purchase),
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
   learned with `GET /chats/{id}`. The intro (and each late joiner's welcome) asks everyone to
   **connect their capital one**: "yes" gets a signed link to the consent page on the trip site, whose
   callback (`POST /connect-callback`) links and seeds that person's Nessie customer
   (a persona-varied profile) and computes their budget. "no" gets asked for a rough number; one
   nudge after a day (`bank_connections`, `features/connect.ts`). The chat calls it their connected Capital One account and never says Nessie,
   sandbox or demo.
2. Friends talk. Each burst becomes one turn. **Extraction** runs on every batch in parallel with
   the **speak gate**, so Atlas learns even when it stays silent. Facts land with quotes; the
   aggregator resolves the current truth.
3. Atlas asks for missing dates and home cities **once per person** (`asks`). Once a majority has
   shared, it moves on.
4. "what's our budget" runs deterministically: budgets from each person's Nessie data, the formula
   in three lines, "based on everyone's last few months of spending". Budgets are **private by
   default**: the group sees only the pooled per-person number (none at all with two people);
   individual numbers appear only for people who said "share my budget", and in each person's DM.
5. "atlas give us some options" goes through constraints, the hard filter, scoring, live pricing
   for the top five, three options with per-person breakdowns, and a **native poll**.
6. Votes come in (native, tapback or text), reconciled against Linq's voter list. A majority (or
   everyone voting, without a tie) **locks** the trip: destination, dates, itinerary and booking
   links. A tie is called out once ("pick for us" takes the cheaper option). If at least half the
   group has voted and nobody votes for 30 s, Atlas names who hasn't, once per poll
   (`poll.remind` job); "skip" closes the poll with the votes in. "can we do X instead?" after a lock
   reopens it as a two-option poll. That fires `onTripLocked`: a recurring **weather.check** job and a decision memory. Once dates
   are set, `find_stays` searches SerpApi google_hotels (hotels and `vacation_rentals=true`), sized
   for the group and filtered to its budget, and polls three options. The winner is booked
   (`trips.stay`) onto the **trip fund**: a Nessie customer "<Trip> Trip Fund" with a checking
   account. Each person's share (by `split_mode`) is planned as contributions on the day after each
   payday before a deposit deadline two weeks out; the `fund.collect` job moves them as Nessie
   transfers checking → fund (ledger only for people with no bank) and pays the stay as a fund
   purchase once it's covered. `add_to_fund` puts shared costs on it; `show_fund` is the status.
7. During the trip, "i paid 64 for dinner" becomes a Nessie purchase on the payer's account, a
   ledger row and a spend event. Disputes from anyone but the payer wait for the payer's "yes".
8. "settle up" squares the tab and the fund together (`src/money/fund.ts`): a fund leftover is
   refunded pro-rata (fund → checking) first; a shortfall makes the fund one more creditor. It
   proposes the fewest transfers. Each payer's "confirm" executes a Nessie transfer
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
  a trip/money question to the room, an objection or a change of mind → agent, no gate call
  untagged chatter with no trip or money words → stop, no gate call (extraction still reads it)
  otherwise not addressed → speak gate (gemini-3.5-flash-lite, temp 0, 3.5 s timeout, JSON {decision, reason}, deterministic fallback on quota errors)
                  input: last 12 messages, stage, facts, deterministic hints (stuck poll, date conflict,
                  majority shared, installments due, trip over), minutes since Atlas spoke, unprompted count
  extraction result: a fresh disagreement can trigger one unprompted line (≤12 unprompted/hour)
  agent (gemini-3.5-flash-lite, ≤4 tool rounds): stateless situation (trip, resolved profiles with quotes,
         feature sections, allowed figures, recalled memories, last 30 messages, new messages)
  output guards: a promise with no tool call gets one more round; a claim about someone's dates or
         city that nobody gave is cut; an unprompted bubble that restates a recent ask or nudge
         (atlas_log, pg_trgm > 0.6) is dropped
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

## Trip pages

Atlas's Postgres is the source of truth; Supabase holds a published copy that the `web/` site reads
server-side with the service-role key (RLS on, no policies: the anon key reads nothing, and pages
are reachable only by UUID).

- **Atlas writes the content.** The agent authors the page as structured JSON through tools:
  `update_itinerary` (days → items with time, setting and a note; each given day replaces that day)
  and `set_trip_summary` (2–3 sentences, optional rename). `src/site/content.ts` validates it with
  zod: dates inside the trip, length limits, and no dollar figures (costs come from the catalog
  when an item names a catalog activity). Locking in doesn't post a code-drafted plan: the lock tool
  tells the agent to write it in the same turn, and a lock decided by a vote queues
  `site.itinerary_nudge`, a follow-up turn that asks Atlas to write it. If three nudges get no plan
  (a busy chat, models out of quota), the catalog draft (`draftItinerary`) is saved and linked so the
  page is never empty.
- **Publish, then link.** iMessage fetches a link's preview when it lands, so the page is written
  first. On a meaningful change (`start_trip`/`switch_trip`, `update_itinerary`, a weather swap) the turn
  publishes and appends a `link` action after its own replies; research publishes from its job. If
  Supabase is down, a `site.announce` job retries and posts the link later.
- **Silent sync.** After every group turn a debounced `site.sync` job copies new chat lines
  (`messages.id` > `trips.site_message_cursor`) and the current state, without posting.
- **Previews.** Each section (`/t/<id>`, `/itinerary`, `/research`, `/chat`) has its own
  `og:title`/`og:description` and a text-only 1200×630 `opengraph-image`. Links carry
  `?v=<site_version>` because iMessage caches previews by URL.
- **Research.** Every lock-in queues `research.run`: three lookups through `web_search`'s pipeline
  (things to do, food, events on the trip dates; keyless search, pages read, every item checked
  against its page), each saved to `trip_research` with its source, then a one-line-per-topic
  summary and the research link in the chat. Every `web_search` Atlas runs for a trip during the
  chat (lists and facts) is saved to the page too.
- **Privacy.** `src/site/snapshot.ts` is the boundary: first names only (no handles), no budgets,
  balances or payment plans, and DMs are never published.

## Memory design

Research and trade-offs: `docs/memory-research.md`.

- **Write:** after each turn a `memory.embed` job embeds message windows (≤2,400 chars,
  speaker-labeled, pure acknowledgements skipped) and resolved facts (budget amounts omitted).
  Decisions are written when a trip locks. Rows record chat, person, kind, visibility and source
  message ids, and writes are idempotent.
- **Read (hybrid):** one SQL statement ranks this chat's history and decisions twice, by BM25
  (`pg_textsearch`, `memory_chunks_bm25`) and by vector distance (pgvectorscale `diskann`), and
  fuses the ranks with reciprocal rank fusion (k = 60). A word match always counts; a vector-only
  neighbour must reach cosine 0.70 with Gemini embeddings. Results are reranked by
  `similarity × (0.85 + 0.15·e^(−age/14d)) × importance` (decisions 1.2), top 8. Only chunks made
  entirely of lines the agent can already see (the last 30 + this batch) are skipped. A query
  with no content words ("ok yes") recalls nothing, and a one-word query ("gatlinburg?") is a free
  BM25 search with no embedding call. Facts aren't recalled from chunks: every member's resolved
  facts are in the situation each turn, and old fact chunks go stale.
- **Atlas's own words (`atlas_log` hypertable):** every bubble Atlas sends is classified with no
  model call (ask, nudge, proposal, decision, money, answer), along with who it named and which
  details it asked for. The agent sees "what you already said" with who's still quiet since each
  ask. An unprompted bubble whose `pg_trgm` similarity to an ask or nudge from the last 6 hours
  is over 0.6 is dropped before it's sent, so Atlas doesn't nag with the same line twice.

## Reliability rules

- Every webhook is persisted before the 200. Unprocessed events replay on boot; anything older
  than 5 minutes is extraction-only, never answered.
- Inbound can't die: per-record try/catch, all-optional `message.schema` extras, and a rebuild if
  `app.messages` ever ends.
- Money side effects mark the turn non-cancellable and are keyed by source message, so redeliveries
  and retries never double-log or double-send.
- Nessie: last-good cache for reads, circuit breaker, offline generated profiles when no key is set,
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
| Trip fund, expenses, settle-up | Capital One | Fund account filled by transfers on paydays, stay paid as a fund purchase; "i paid 64" becomes a Nessie purchase; settle-up becomes Nessie transfers after "confirm" |
| Memory + aggregates | Tiger Data, Gemini | Recall weeks later; diskann; `trip_spend_daily` and `forecast_drift_daily` in chat and console |
| Weather watch | General | Injected or real forecast flip leads to a swap offer and poll |
| Write-up | DEV challenge | `docs/dev-post.md` |
| Domain | .Tech | Landing page on a .tech domain |
