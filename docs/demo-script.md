# Demo script: three friends plan a trip (about 6 minutes)

**Cast:** Maya, Leo and Priya, three phones in one iMessage group, plus the Atlas Linq number.
**Screen:** one phone mirrored (or the simulator), with the judge console
(http://127.0.0.1:8790) beside it.
**Rehearse it:** `npm run sim -- run demo/rehearsal.chat` (offline) or add `--live` for Gemini.
Dollar figures below are illustrative; `npm run demo -- warm` prints your roster's real ones.

## Before you go on

```bash
npm run doctor
```

```bash
npm run demo -- warm
```

```bash
npm run live
```

- `doctor` should be all green, or green apart from optional SerpApi.
- `warm` seeds Nessie profiles for the roster and prints each budget, so you know the numbers.
- `live` starts Atlas plus the Linq relay. Leave it running.
- Pick trip dates within the next 16 days so the forecast is real (the weather beat injects a
  change either way).
- If something misbehaves live: `npm run ops -- say <chatId> "<text>"`, `npm run ops -- mute <chatId>`,
  or switch to the simulator (same brain, same database).

## 1. Atlas joins (Photon · General)

Maya adds the Atlas number to the group.

> **Atlas:** hi, i'm atlas, your trip and financial planner. i'll listen in, keep track of what everyone wants and what everyone can spend, and help us actually book this thing. you can tell me to stay quiet any time
> **Atlas:** i read along and jump in to keep the plan moving…budgets i suggest come from demo spending profiles (sandbox data, not your real bank)…
> **Atlas:** so where are we thinking, and when?

**Say:** "That's a real iMessage group on a real number. We wrote a custom Spectrum platform for a
Linq line. Every webhook is signature-checked and stored before we acknowledge it."

## 2. It knows when to stay quiet (Gemini)

> **Leo:** lol did anyone see the game last night
> **Priya:** insane

Atlas stays silent. **Console, speak gate panel:** `NO_REPLY · banter`.

**Say:** "A Gemini Flash-Lite gate reads the last 12 messages and decides SPEAK or NO_REPLY. If
it's ever unsure, it stays quiet."

## 3. It reads the conversation (Gemini · General)

> **Maya:** ok real talk, i'm free nov 12–16, flying out of raleigh, and i want a beach
> **Leo:** cancun is too pricey for me and i'm vegetarian. same dates, i'd leave from charlotte
> **Priya:** 12–16 works but i can only do driving distance. beaches bore me, i'm all about food

> **Atlas:** maya wants a beach and priya's more of a food person, and priya can only drive. a beach town with a real food scene covers both

**Console, facts panel:** every fact with the words it came from. "cancun is too pricey for me"
is a **veto** at 0.95 confidence, plus vegetarian, "no flying" and the date window.

**Say:** "No forms. Gemini reads the language; deterministic code decides what's true."

## 4. Budgets from account data (Capital One)

> **Leo:** what's our budget?
> **Atlas:** 💰 budgets stay private, so here's just the pooled number: everyone's good up to $225 each (based on everyone's last few months of spending, from your connected accounts)
> **Atlas:** how i got these: what you earn, minus bills and everyday spending, for each month until the trip, then half of that… yours stays private unless you say "share my budget"…

> **Maya:** share my budget
> **Atlas:** ok maya, i'll share your budget with the group 👍

(DM Atlas "what's my budget?" to show the full private breakdown.)

**Console, budgets and Nessie calls:** each person has a Nessie customer id, with the formula
inputs and the API calls that created their paychecks, bills and purchases.

**Say:** "When Atlas first sees you, it creates a Capital One Nessie customer for you with months of
generated history: paychecks, Verizon and Duke Energy bills, Harris Teeter runs. In the chat it's
just your connected Capital One account, and budgets are private by default: the group only sees
the pooled number."

## 5. Three options and a poll (General · Photon)

> **Maya:** atlas give us some options
> **Atlas:** three options for nov 12–16, per person (estimates)…
> **Atlas:** 1. Savannah: ~$555 per person…
> *(a native iMessage poll appears)*

Maya and Leo vote for Savannah in the poll.

> **Atlas:** savannah wins (2 of 3). savannah is locked in for nov 12–16 🎉
> **Atlas:** ready to book? links 👇 …
> **Atlas:** (trip page link: the day-by-day plan Atlas just wrote, as an iMessage preview card)
> **Atlas:** payment plan for everyone's share…set up as nessie bills timed to your paydays…

**Say:** "Cancún never appears; it was vetoed. Every option is drivable for Priya and works for
Leo's diet. Prices are live fares when available, otherwise estimates, and the message says which."

## 6. The weather changes (General)

```bash
npm run ops -- weather <chatId> 2026-11-14 rain 80
```

> **Atlas:** saturday flipped to rain (80%). want to swap the beach day for the food market tour on friday?
> *(a "swap saturday's plan?" poll)*

**Console, forecast panel:** every fetch is stored in a TimescaleDB hypertable, and the
`forecast_drift_daily` continuous aggregate shows how the forecast moved.

## 7. Money during the trip (Capital One)

> **Maya:** i paid 64 for dinner
> **Atlas:** logged #1: dinner $64.00, paid by maya (nessie purchase ✓). split 3 ways: leo + priya owe maya $21.33 each

> **Priya:** wait dinner was 46 not 64
> **Atlas:** maya, priya wants to make it $46.00 for #1 (dinner, $64.00). reply "yes" to fix it or "no" to keep it
> **Maya:** yes
> **Atlas:** fixed (was #1, now #2): dinner $46.00…

> **Leo:** atlas let's settle up
> **Atlas:** settle-up, the fewest transfers that square everything (2): leo → maya …, priya → maya …
> **Leo:** confirm
> **Atlas:** ✓ sent: leo → maya $15.33 (nessie transfer ✓)

**Say:** "Money moves only after the person paying confirms, and every figure traces to a Nessie
object. Our settle-up computes the true minimum number of transfers."

## 8. It remembers (Tiger Data · Gemini)

> **Maya:** atlas what did leo say about the food again?
> **Atlas:** leo said he's vegetarian, and the savannah food tour is veg friendly…

**Console, memory panel:** the recall hits with their scores, from pgvector over a pgvectorscale
`diskann` index.

**Close:** "Atlas lives where the plan actually happens, in the group chat. It listens, it does
the math, and it knows when to be quiet."
