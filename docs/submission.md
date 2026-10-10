# Devpost submission: Atlas

## Inspiration
Friend-group trips die in the group chat. Nobody wants to be the one tracking everyone's dates,
diets, budgets and travel limits, so the plan never leaves "we should go somewhere."

## What it does
Atlas is a trip and financial planner that lives inside an iMessage group chat:
- It **reads the conversation** and builds a per-person profile from natural chat: vetoes, dates,
  diets, interests and travel limits, each with the words it came from and a confidence.
- It **computes each person's budget from account data** (Capital One Nessie sandbox: paychecks,
  recurring bills, everyday spending) with a formula it explains in three lines. Budgets can be
  kept private (pooled-only).
- It **proposes three destinations** that pass everyone's hard constraints, priced with live fares
  where available and labeled estimates otherwise, then runs a **native iMessage poll**. A majority
  locks it in.
- It **runs the money through Nessie**: a payment plan as bills timed to paydays, expenses as
  purchases, and settle-up as transfers, each executed only after the payer confirms.
- It **remembers** everything in Tiger Data (pgvector + pgvectorscale) and **watches the
  forecast**, offering a concrete swap when it changes.
- It **knows when to stay quiet**: a deterministic check plus a Gemini Flash speak gate, and
  "stay quiet" mutes it.

## How we built it
- **Transport:**
  - TypeScript on Photon Spectrum, with a custom Spectrum platform for a Linq iMessage line
    (signature-checked webhooks persisted before acknowledgment, idempotent sends, native polls,
    text fallbacks for everything).
  - Local and cloud iMessage providers behind the same switch.
  - A simulator line for development and testing.
- **Gemini:** `gemini-3.8-flash` for the agent and extraction, `gemini-3.5-flash-lite` for the
  speak gate, and `gemini-embedding-2` for memory.
- **Tiger Data:**
  - Postgres with pgvector + pgvectorscale (diskann) for semantic memory.
  - TimescaleDB hypertables and continuous aggregates for spend and forecast drift.
  - A Postgres job queue with a job-failure audit table.
- **Capital One Nessie:** customers, accounts, deposits, withdrawals, bills, purchases, merchants
  and transfers. A probe script records which payload shapes the live API accepts, and the app
  adapts to them.
- **SerpApi** Google Flights/Hotels for live prices, with caching and estimate fallbacks.
  **Open-Meteo** for forecasts.
- **Deterministic code** for money and constraints: exact-cents splits, an exact minimum-transfer
  settle-up, the budget engine, constraint filtering and scoring. A money guard blocks any dollar
  figure the model writes unless it came from a tool or a labeled estimate.

## Challenges we ran into
- Group iMessage access: shared-pool lines can't join groups, which led us to a custom Linq platform.
- Nessie quirks: balances never update, transfers can't name a payee, and amounts drop cents. We
  replay balances, pair transfers with deposits, and keep exact cents in our ledger.
- Making an agent quiet by default without making it seem broken.

## Accomplishments we're proud of
- 633 automated tests and 9 end-to-end chat scenarios that run with no phones.
- Every dollar figure in the chat traces to a Nessie object or a labeled estimate.
- Settle-up that is provably minimal.

## What we learned
Most of a good group-chat agent is deciding not to talk, and keeping the model away from the math.

## What's next
Receipt photos, real bookings, and per-trip shared itineraries.

## Built with
TypeScript, Node.js, Photon Spectrum, Linq, Google Gemini, Tiger Data (PostgreSQL, TimescaleDB,
pgvector, pgvectorscale), Capital One Nessie, SerpApi, Open-Meteo, Vitest.

## Tracks
General · Photon (iMessage agent on Spectrum) · Capital One (Nessie) · Tiger Data · Gemini API ·
DEV writing challenge · .Tech domain.

## Acknowledgments
Our Linq transport, terminal simulator and `.chat` scenario format, two-stage speak-gate design,
vote parsing, and expense-split and settle-up math were adapted from
**[scout](https://github.com/ethanyanghq/scout) by Ethan Yang, used with his explicit permission.**
The adapted code is in its own commits with source headers; see NOTICE in our repository.
Weather data by Open-Meteo (CC BY 4.0).
