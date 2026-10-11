---
title: "We built an AI that lives in our group chat and knows when to shut up"
published: false
tags: mlhacks, ai, typescript, postgres
---

*Built at HackNC 2026.*

Our friend group has planned roughly eleven trips in a group chat and taken two of them. So for
HackNC we built **Atlas**: you add its number to an iMessage group, and it becomes the friend who
keeps track of everything and actually gets the trip booked.

Here are the parts that were harder than they looked.

## 1. Getting an agent into a real group chat

Group iMessage is surprisingly gated. Shared-pool lines on most agent platforms can't join groups
at all, so we wrote a custom [Spectrum](https://photon.codes/docs/spectrum-ts) platform for a
[Linq](https://linqapp.com) line. Linq delivers webhooks at least once, so:

- every webhook is **signature-checked** (Standard Webhooks HMAC) and **written to Postgres before
  we acknowledge it**, keyed by its id, so a redelivery is a no-op and a crash can't lose a message;
- one bad event never ends the stream. We learned the hard way that a single rejected promise in
  an ordered-emit chain silently stops all inbound;
- every outgoing message carries a stable client GUID as Linq's `idempotency_key`, so retries
  can't double-send.

## 2. Knowing when to speak

Most messages in a group chat aren't for the bot. Atlas runs a two-stage gate:

1. **Deterministic:** was it tagged, replied to, or is someone answering a question Atlas just
   asked (and if it asked a specific person, only that person's answer counts)?
2. **A Gemini Flash-Lite call** sees the last 12 messages plus deterministic hints (a poll stuck
   for 6 hours, date windows that don't overlap) and returns `{decision, reason}`. It runs at
   temperature 0 with a 3.5-second timeout, and if anything fails it stays silent.

Then the main agent can still say `NO_REPLY`. Bursts are debounced into one turn, and a new
message cancels an in-flight reply unless a money side effect has already started.

## 3. The LLM does language; code does money

Every dollar figure Atlas sends is checked by a **money guard**. Tools register each figure they
produce with its source (a Nessie object id, "live fare" or "estimate") and its visibility. If the
model writes a number that no tool produced, or one that belongs to someone's private budget, the
model's text is dropped and the deterministic template goes out instead.

Budgets come from the [Capital One Nessie](https://nessieisreal.com) API. Atlas creates a customer
for each friend (their first name, a generated last name) with months of generated paychecks, bills
and purchases at real-sounding payees and merchants, presents it in the chat as their connected
Capital One account, and computes:

1. `monthly_free = median paychecks − recurring bills − median everyday spending`
2. `suggested = monthly_free × months until the trip × 0.5`
3. `budget = min(suggested, balance − next month's bills)`, rounded down to $25

Nessie quirk: account balances never change after transactions, so we replay them. A test proves
that budgets computed from data read back out of Nessie exactly match the generated profile.

Settle-up is an exact minimum-transfer solver: a bitmask DP over zero-sum subgroups. The common
greedy approach isn't optimal. With balances +6, +4, −4, −3, −3, greedy needs 4 transfers and the
optimum is 3.

## 4. Memory that scopes correctly

Messages and extracted facts are embedded with Gemini (`gemini-embedding-2`, 768 dims) into
[Tiger Data](https://www.tigerdata.com) Postgres with a pgvectorscale **diskann** index. History is
scoped per chat, while facts about a person follow them across chats. Private facts never surface
in a group. Recall reranks cosine similarity with a gentle recency decay. Spend and forecasts live
in TimescaleDB hypertables with continuous aggregates, which give "we're $211 in" and the forecast
timeline for free.

## 5. Testing a group chat without phones

The whole pipeline runs against a simulated line. Scenarios are plain text:

```
maya: i paid 64 for dinner
expect atlas ~ "split 3 ways: leo + priya owe maya $21.33 each"
priya: wait dinner was 46 not 64
expect atlas ~ "maya, priya wants to make it $46.00"
```

Model answers can be scripted inline, so scenarios run offline and deterministically, or live
against Gemini. We have 9 scenarios and over 600 unit and integration tests against a real
Postgres.

## What we'd do next

Receipts from photos, real booking, and recording live model sessions for regression testing.

---

*Acknowledgments: our Linq transport, simulator and speak-gate design started from
[scout](https://github.com/ethanyanghq/scout) by Ethan Yang, used with his permission.*
