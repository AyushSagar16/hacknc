# Atlas

**A trip and money planner that lives in your friend group's iMessage chat.**

## How we got it into the group chat

Atlas is a member of the group, not an app. It has its own phone number on a real iMessage line, so
you add it to a group chat the same way you'd add a friend. Nobody installs anything or fills in a
form.

Getting there took three pieces:

1. **A real iMessage line.** Every message in the group reaches our server as an event, and Atlas
   replies from its own number. Each delivery is signature-checked and saved before it's
   acknowledged, so nothing is lost if Atlas restarts mid-conversation.
2. **[Photon Spectrum](https://photon.codes/docs/spectrum-ts) as the messaging layer.** Spectrum
   gives us one interface for iMessage: sending, tapbacks (👍), native polls, threaded replies and
   typing indicators. We wrote a custom Spectrum platform for our line, plus a simulator platform
   so the same code runs as a terminal group chat with no phones. Anything a line can't do natively
   falls back to plain text (a poll becomes a numbered list you vote on by replying).
3. **Group-chat manners.** A group is noisy, so Atlas has to know when to talk. Bursts of messages
   are batched, and a newer message cancels a reply that's already in progress. A fast "speak gate"
   model decides whether to chime in: trip and money talk, yes; banter, no. When it's waiting on
   someone it reacts with a 👍 instead of going silent, follows up when the group goes quiet, and
   "atlas stay quiet" mutes it. Each group chat is its own sandbox, so one group's plans never leak
   into another's.

## What it does

Add Atlas's number to the group. It introduces itself, then reads along, picking up what everyone
wants ("cancun is too pricey for me", "i'm vegetarian", "i can't fly after the 14th") and what
everyone can spend. From there it keeps the plan moving:

- proposes priced options that fit the group, and runs a poll
- finds a place to stay and books it from a shared trip fund that everyone pays into on payday
- shortlists food and things to do near the stay, then writes a day-by-day plan on a trip page
- watches the forecast and suggests swaps ("saturday flipped to rain, want to swap the beach day?")
- splits expenses during the trip and settles up at the end

Budgets are private by default. The group only sees the pooled number, and each person can text
Atlas to see their own.

## The stack

| Piece | What it does |
|---|---|
| **TypeScript / Node 22** | The whole backend |
| **[Photon Spectrum](https://photon.codes/docs/spectrum-ts)** | iMessage messaging: sends, tapbacks, polls, replies, typing |
| **[Google Gemini](https://ai.google.dev)** | Language only: replies, the speak gate, pulling preferences out of chat, and embeddings for memory |
| **[Tiger Data](https://www.tigerdata.com)** (Postgres + TimescaleDB, pgvector, pgvectorscale) | Messages, memory, job queue, spending and forecast history |
| **[Capital One Nessie](https://nessieisreal.com)** | Generated bank accounts behind each person's budget, the trip fund, purchases and settle-up |
| **[SerpApi](https://serpapi.com)** + web search | Live flight and hotel prices, things to do, food and events |
| **[Open-Meteo](https://open-meteo.com)** | Forecasts and climate data |
| **Next.js on Vercel + Supabase** | The trip pages Atlas publishes for each trip |

## How it works

```
group chat ─► iMessage line ─► saved event ─► Spectrum ─► Atlas
                                                           │
   batch the burst ─► commands, votes, "i paid 64 for dinner" (plain code)
                   ─► pick up preferences (Gemini)
                   ─► should Atlas speak? (Gemini, fast model)
                   ─► reply with tools: options, budgets, money, weather, memory
                   ─► money guard ─► send back to the group
```

- **The models only do language.** Money, budgets, constraints, polls and schedules are plain,
  deterministic code. Every dollar figure Atlas writes has to trace back to a real calculation or a
  labeled estimate, or the reply is blocked.
- **It remembers.** Every message is stored and searched before each reply (keyword plus vector
  search), so Atlas can recall something said weeks ago. It also remembers its own messages, so it
  doesn't repeat itself.
- **It only cites what it read.** Anything it suggests from the web has to appear on a page it
  actually fetched.
- **Budgets come from account data.** Each person's suggested budget is computed from months of
  generated paychecks, bills and purchases in Nessie, never anyone's real bank.

## Try it

No phones or keys needed:

```bash
npm install
```

```bash
npm run db:up
```

```bash
npm run sim
```

This opens a group chat in your terminal with Maya, Leo and Priya, and adds Atlas. Add a
`GEMINI_API_KEY` to `.env` for live model replies.

Setup for a real line, environment variables, the full pipeline, models, testing and project
layout are in **[docs/technical.md](docs/technical.md)**. The design is in
[docs/architecture.md](docs/architecture.md) and the memory work in
[docs/memory-research.md](docs/memory-research.md).

## Credits

Atlas adapts code and ideas from **[scout](https://github.com/ethanyanghq/scout) by Ethan Yang**,
used and adapted **with the author's explicit permission**. That includes the simulator
foundations, the two-stage speak gate, the `.chat` scenario format, vote parsing, and the
expense-split and settle-up math. The upstream repository has no license file; the author's
permission is the basis for this use. Adapted code lives in its own commits titled
`import from scout (used with author permission)`, and each adapted file names its source in a
header. The full list is in [NOTICE](NOTICE). Thank you, Ethan.

The iMessage line Atlas runs on is provided by [Linq](https://linqapp.com), connected to Spectrum
through a custom Linq platform (also adapted from scout). Weather data by
[Open-Meteo](https://open-meteo.com), licensed CC BY 4.0.
