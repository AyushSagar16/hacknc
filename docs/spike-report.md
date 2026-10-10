# Step 0 spike: group chat transport

*Written 2026-10-10. The question: how does Atlas get into a real iMessage group chat with what
we have (a Photon Pro plan), reliably enough to demo?*

## Findings

### Photon Spectrum Cloud on our Pro plan can't do groups

I verified this in the installed SDK, `@spectrum-ts/imessage` 12.10.1:
- In shared-pool mode (Free/Pro), `space.create` with more than one user throws `UnsupportedError`
  ("shared mode cannot create group chats", `dist/index.js` ~3011).
- In shared-pool mode the provider never subscribes to group events: `includeGroupEvents = !shared`,
  ~2622.
- Each recipient may be routed through a different pool number, so one group could see Atlas
  under two different numbers.

The Photon pricing page confirms that groups need a dedicated Business line ($250 per line per
month).

What does work on the cloud provider with a dedicated line: native polls (`remote.polls.create`,
with votes delivered as `poll_option`), tapbacks, threaded replies and group membership events.
Atlas supports this as `IMESSAGE_MODE=cloud` in case we upgrade.

### Local iMessage works in groups, with fewer features

`@spectrum-ts/imessage-local`, which the repo used before this work, reads the Messages database on
a Mac signed in to an Apple ID:
- It receives and sends text and attachments in **existing** groups (`space.get(chatGuid)`).
- It **cannot** send polls, tapbacks, threaded replies, edits or read receipts. Those throw
  `UnsupportedError`, which Spectrum turns into warn-and-skip.
- It can't create groups.

Atlas supports this as `IMESSAGE_MODE=local`. The text fallbacks are covered by tests: numbered
text polls voted by number or 👍, and plain-text acks.

### Linq free line: the chosen path

Linq gives a real iMessage number with an HTTP API and webhooks, so no Apple ID or Mac Messages
account is needed. From the Partner API v3 docs and the reference team's experience:

| Capability | Status | How Atlas handles it |
|---|---|---|
| Group text in and out | Documented; used in real groups by the reference team | Native |
| Webhook delivery | At least once; Standard Webhooks signatures | Event log keyed by `webhook-id`; signature verified (session secret captured from `linq webhooks listen`) |
| Typing indicator in groups | **403** observed by the reference team | Skipped after the first 403 per chat; never fails a send |
| Tapbacks out/in | Documented; never verified on a real line by the reference team | Native, with a text fallback if the send fails |
| Threaded replies | Documented; never verified on a real line by the reference team | Native, with a plain-text fallback |
| **Native polls** | Documented (`POST /chats/{id}/polls`, `poll.vote.added/removed`); no title field | Question sent as its own bubble, then the poll; votes mapped back through `GET /messages/{id}/poll` |
| `idempotency_key` on sends and polls | Documented | Set from the outbox's stable client GUID |
| `participant.added` / `chat.created` | Documented | Atlas joining a group triggers the intro; friends joining get a short welcome |
| Free line limits | 20 contacts; each must text the line first; groups ≤31 members, ≥3 to add someone; 30 msgs/min per pair | `npm run demo -- setup` checks who has texted; pacing between bubbles |
| Stale relay webhooks | Caused 9-minute-late, out-of-order events for the reference team | `npm run live` deletes `…/relay/…` subscriptions before starting |
| Two processes on one line | Both answered for the reference team | One line per teammate; echo detection logs loudly if this line sends something we didn't |

**Still to verify on our own line** (this needs the Linq signup and the friends' phones; it's the
first thing to run once the line exists):
- [ ] group receive and send
- [ ] typing returns 403 in groups
- [ ] tapback out and in
- [ ] threaded reply
- [ ] native poll and `poll.*` events on a free Shared line
- [ ] `idempotency_key` dedupes a resend
- [ ] which event fires when Atlas is added (`participant.added` vs `chat.created`)
- [ ] how a shared link arrives

The webhook mapper accepts both documented payload versions and logs anything it can't read, so
an unexpected shape never ends the stream. Save the first real payloads, with phone numbers
redacted, to `test/fixtures/linq/` and add them to `test/unit/linq-events.test.ts`.

## Decision

| Mode | Use |
|---|---|
| `linq` | **Primary**, for the demo and day to day. A free line per teammate. |
| `sim` | All development and testing. The real pipeline and brain, a fake line, scripted or live model. |
| `local` | Backup if Linq misbehaves: a spare Apple ID on the demo Mac. |
| `cloud` | If we ever buy a Photon Business line. Native polls, tapbacks and group events, no code changes. |

All four are behind one switch (`IMESSAGE_MODE`). The pipeline, brain and tests are identical across them.

## What we took from scout (ethanyanghq/scout @ 60f567b, used with Ethan Yang's permission)

I read the repo through the GitHub API and cloned it into a scratch directory outside our repo. It
has no LICENSE file, so the author's permission is our license. We wrote our own TypeScript and
adapted only what earned it. Adapted files carry a provenance header and landed in their own
`import from scout` commits.

| Area | Verdict | What we did differently |
|---|---|---|
| `bridge/linq.ts`, `linq-api.ts` (Linq as a Spectrum platform) | **Adapted** | Signature verification; zod payloads for both versions; a durable event log written before the ack (theirs acks first, with an in-memory dedupe set); a failed handler can't stop inbound (in theirs, one rejected promise ends it); native polls, membership events, idempotency keys, custom emoji |
| `bridge/devchat/*` (terminal simulator) | **Adapted** | In-process, many chats, switchable capabilities (Linq-like vs local-like), clock travel, DMs, native poll votes |
| `bridge/devchat/script.ts` (`.chat` format) | **Adapted** | Scripted model answers so scenarios run offline and deterministically; SQL and trip-state expectations |
| `speak_gate.py` (two-stage gate) + `trip.py` mention regex | **Adapted** | Structured `{decision, reason}` at temperature 0 with a timeout; deterministic hints (stuck poll, deadline, constraint); configurable name; reply detection by message id instead of exact text |
| `expense_split.py` (largest remainder) | **Adapted** | Remainder cents go to the payer; BigInt-exact |
| `settle_up.py` | **Adapted** | An exact minimum-transfer DP (their greedy isn't minimal: A+6, B+4, C−4, D−3, E−3 needs 3 transfers, not 4) |
| `polls.py` (strict vote parsing) | **Adapted** | Accent folding; multi-select and deselect-aware tallies for native polls |
| `bridge/index.ts` mode switch, outgoing action model, rival guard, system prompt rules, demo roster/setup, supervised CLI relay | **Ideas only** | Rewritten for our stack; the rival guard became echo detection instead of a GET before every send |
| Python service (`agent.py`, `trip_actions.py`, `trip_store.py`, …) | **Ideas only** | One TypeScript process on Postgres instead of two runtimes over HTTP |
| HermesShare cards, flights/hotels/brochures, media (`sips`/`afconvert`), landing site | **Skipped** | Out of scope. No macOS-only tools anywhere |
