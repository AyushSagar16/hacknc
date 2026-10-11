// Trip stages in the agent's context (where the plan stands, the next thing to settle) and the
// dates stage: find_dates works out when the group can go from everyone's free/busy dates
// (src/trips/availability.ts) and posts one pick to 👍 or a quick poll between two or three.
// A decided dates poll sets the trip's dates; if the place is already settled, the travel
// rundown follows right away.
import { one } from "../../db/pool.ts";
import { recordAsk } from "../../profile/store.ts";
import { findDateWindows, type Conflict, type DateWindow, type PersonAvailability } from "../../trips/availability.ts";
import { createPoll, openPolls, recordVote, votesFor, type PollRow } from "../../trips/pollStore.ts";
import { describeStages, getStages, nextStage, setStage, STAGE_LABEL, type Stage, type StageMap } from "../../trips/stages.ts";
import type { Feature, TurnCtx } from "../feature.ts";
import { num, say, type Tool } from "../tools.ts";
import { applyTripDates, DATES_POLL_KIND, formatRange, nameList } from "./planning.ts";
import { afterVote } from "./proposals.ts";
import { postTravelPlan } from "./travel.ts";

const first = (label: string) => label.toLowerCase().split(/\s+/)[0] ?? label.toLowerCase();

function day(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
}

/** "leo's busy nov 14–15", "priya's free from nov 20", "sam has to be back by nov 15". */
export function conflictText(c: Conflict): string {
  if (c.kind === "starts_later") return `${c.name}'s free from ${day(c.date)}`;
  if (c.kind === "ends_earlier") return `${c.name} has to be back by ${day(c.date)}`;
  return `${c.name}'s busy ${c.start === c.end ? day(c.start) : formatRange(c.start, c.end)}`;
}

/** Who a window works for: "everyone", "all but leo", or names. */
function whoFits(w: DateWindow, groupSize: number, names: Map<number, string>): string {
  if (w.available.length === groupSize) return "everyone";
  if (w.conflicts.length === 1 && w.available.length + 1 === groupSize) return `all but ${w.conflicts[0]!.name}`;
  return nameList(w.available.map((id) => names.get(id) ?? "").filter(Boolean));
}

/** Each person's free/busy dates as the availability engine reads them. */
async function availabilityOf(tc: TurnCtx): Promise<PersonAvailability[]> {
  const view = await tc.view();
  return view.members.map((m) => ({
    personId: m.personId,
    name: first(m.label),
    earliest: m.profile.earliest?.value,
    latest: m.profile.latest?.value,
    blackouts: m.profile.blackouts.map((b) => b.value),
  }));
}

/** The one-pick message (👍 to lock) or the numbered lines before a poll. */
export function datesMessage(windows: DateWindow[], groupSize: number, names: Map<number, string>): string {
  if (windows.length === 1) {
    const w = windows[0]!;
    const who = whoFits(w, groupSize, names);
    const why = w.conflicts.length ? `\n${w.conflicts.map(conflictText).join(", ")}` : "";
    return `📅 ${formatRange(w.start, w.end)} (${w.nights} ${w.nights === 1 ? "night" : "nights"}) works for ${who}${why}\n👍 this to lock it in`;
  }
  const lines = windows.map((w, i) => `${i + 1}. ${formatRange(w.start, w.end)}: ${whoFits(w, groupSize, names)}${w.conflicts.length && w.available.length + w.conflicts.length === groupSize && w.conflicts.length <= 2 ? ` (${w.conflicts.map(conflictText).join(", ")})` : ""}`);
  const all = windows.every((w) => w.available.length === groupSize);
  return [`${all ? "a few dates work for everyone" : "no dates work for everyone, these come closest"} (${windows[0]!.nights} nights) 👇`, ...lines].join("\n");
}

const findDatesTool: Tool = {
  soloPost: true,
  decl: {
    name: "find_dates",
    description:
      "Work out when the group can go from everyone's free dates and busy dates: posts the dates that work for the most people (one clear pick for a 👍, or a quick poll between 2–3), names who can't make them and why, and asks anyone who hasn't said when they're free. Use when the group is figuring out dates or the situation says dates are next. Pass nights only when the group said a trip length.",
    parameters: { type: "object", properties: { nights: { type: "integer", description: "trip length if the group said one" } } },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const view = await tc.view();
    const people = await availabilityOf(tc);
    const names = new Map(people.map((p) => [p.personId, p.name]));
    const nights = num(args.nights) ?? view.nights.suggested;
    const result = findDateWindows(people, { today: tc.today, nights, minNights: view.nights.min ?? undefined });

    // Ask people who haven't said anything about dates (once each, ever).
    const fresh: string[] = [];
    for (const u of result.unknown) if (await recordAsk(u.personId, tc.chat.id, "dates", tc.now)) fresh.push(u.name);
    const ask = fresh.length ? `${nameList(fresh)}, when ${fresh.length === 1 ? "are you" : "are you all"} free?` : "";
    const n = tc.members.length;

    if (result.candidates.length === 0 || (fresh.length && result.known.length * 2 < n)) {
      if (ask) say(tc, result.known.length ? `need a few more dates before i can find a window. ${ask}` : ask);
      return {
        ok: true,
        data: { known: result.known.length, unknown: result.unknown.map((u) => u.name), asked: fresh },
        next: ask ? "the ask was posted; reply NO_REPLY" : "nobody's dates are known and everyone was already asked; don't ask again, say in one line that you need dates to go on",
      };
    }

    await tc.nonCancellable();
    const windows = result.candidates;
    const poll = await createPoll({
      tripId: tc.trip.id,
      chatId: tc.chat.id,
      kind: DATES_POLL_KIND,
      title: "which dates?",
      options: windows.map((w) => ({ title: formatRange(w.start, w.end), ref: { start: w.start, end: w.end } })),
      at: tc.now,
    });
    await setStage(tc.trip.id, "dates", "in_progress");
    const text = datesMessage(windows, n, names);
    say(tc, ask ? `${text}\n${ask}` : text);
    if (windows.length > 1) tc.out.push({ type: "poll", title: "which dates? 🗳️", options: poll.options.map((o) => o.title), pollId: poll.id });
    return {
      ok: true,
      data: { nights: result.nights, options: windows.map((w) => ({ dates: formatRange(w.start, w.end), works_for: w.available.length, of: n, cant: w.conflicts.map(conflictText) })), asked: fresh },
      next: "the dates were posted; reply NO_REPLY",
    };
  },
};

const AFFIRM = /^\W*(?:👍|yes|yep|yeah|ya|yup|works(?: for me)?|that works|down|i'?m down|sounds good|perfect|lock (?:it|them|those) in|lock it)\W*$/iu;

/** A single-pick dates poll: the 👍 on Atlas's dates message (or "works for me") counts as a vote. */
async function thumbsForDates(msg: Parameters<NonNullable<Feature["fastPath"]>>[0], tc: TurnCtx): Promise<boolean> {
  if (msg.person_id === null) return false;
  const polls = (await openPolls(tc.chat.id)).filter((p) => p.kind === DATES_POLL_KIND && p.options.length === 1);
  if (!polls.length) return false;
  if (msg.kind === "reaction") {
    const tapback = msg.meta.tapback as string | null;
    if (tapback !== "like" && tapback !== "love") return false;
    const target = await one<{ text: string }>(`SELECT text FROM messages WHERE chat_id = $1 AND provider_message_id = $2 AND direction = 'outbound'`, [tc.chat.id, String(msg.meta.targetId ?? "")]);
    const poll = target ? polls.find((p) => target.text.includes(p.options[0]!.title)) : undefined;
    if (!poll) return false;
    await recordVote(poll.id, msg.person_id, 0, msg.meta.removed !== true, "tapback", tc.now);
    await afterVote(poll, tc, msg.person_id, "tapback", msg);
    return true;
  }
  if (msg.kind === "text" && msg.speakable && AFFIRM.test(msg.text)) {
    const poll = polls.find((p) => p.trip_id === tc.trip.id);
    if (!poll) return false;
    await recordVote(poll.id, msg.person_id, 0, true, "text", tc.now);
    await afterVote(poll, tc, msg.person_id, "text", msg);
    return true;
  }
  return false;
}

/** What Atlas should do about the next stage, for the agent. */
const NEXT_GUIDANCE: Record<Stage, string> = {
  location:
    "nobody's settled where yet. gather what people want; propose_destinations for options, or lock_destination when the group agrees on a place (any real place works, even one not in your list).",
  dates: "call find_dates to work out when everyone's free (it asks whoever hasn't said and posts the best dates or a poll); set_trip_dates once the group agrees on dates in words.",
  travel: "where and when are settled: call plan_travel to post how everyone gets there (drive or fly, gas or fare, carpools).",
  stay: "where to stay isn't booked yet.",
  food_activities: "food and things to do aren't picked yet: suggest_places posts a shortlist near the stay that fits what people like and eat.",
};

export function stageLines(map: StageMap, trip: { destination_name: string | null; start_date: string | null; end_date: string | null }): string[] {
  const lines = [`stages: ${describeStages(map)}`];
  if (map.location === "decided" && trip.destination_name) lines.push(`where: ${trip.destination_name}`);
  if (map.dates === "decided" && trip.start_date && trip.end_date) lines.push(`when: ${formatRange(trip.start_date, trip.end_date)}`);
  else if (map.dates !== "decided" && trip.start_date && trip.end_date) lines.push(`dates on file (not confirmed since the place changed): ${formatRange(trip.start_date, trip.end_date)}`);
  const next = nextStage(map);
  if (next) lines.push(`next thing to settle: ${STAGE_LABEL[next]}. ${NEXT_GUIDANCE[next]}`);
  else lines.push("every stage is settled.");
  lines.push(
    "nudge toward the next thing to settle only when it fits the conversation, in passing, never as a nag. if someone gives info for a later stage (dates before the place, \"i'll drive\"), it's saved anyway: acknowledge it, don't make them repeat it later.",
  );
  return lines;
}

export const stagesFeature: Feature = {
  name: "stages",
  tools: [findDatesTool],

  async fastPath(msg, tc) {
    return thumbsForDates(msg, tc);
  },

  async onPollDecided(poll: PollRow, winnerIdx: number, tc: TurnCtx) {
    if (poll.kind !== DATES_POLL_KIND) return false;
    const ref = poll.options[winnerIdx]?.ref as { start?: string; end?: string } | undefined;
    if (!ref?.start || !ref.end) return true;
    await tc.nonCancellable();
    const applied = await applyTripDates(tc, ref.start, ref.end);
    const votes = (await votesFor(poll.id)).filter((v) => v.optionIdx === winnerIdx && v.selected);
    const count = new Set(votes.map((v) => v.personId)).size;
    const n = tc.members.length;
    const tally = poll.options.length === 1 ? `${count} of ${n} 👍` : count >= n && n > 1 ? "unanimous" : `${count} of ${n} votes`;
    say(tc, `📅 ${formatRange(ref.start, ref.end)} it is (${tally})`);
    if (applied.travelNext) await postTravelPlan(tc).catch(() => undefined);
    return true;
  },

  async situation(tc) {
    const map = await getStages(tc.trip.id);
    const lines = stageLines(map, tc.trip);
    const datesPoll = (await openPolls(tc.chat.id, tc.trip.id)).find((p) => p.kind === DATES_POLL_KIND);
    if (datesPoll?.options.length === 1) {
      const votes = await votesFor(datesPoll.id);
      const yes = votes.filter((v) => v.selected).map((v) => tc.label(v.personId));
      lines.push(`dates pick waiting on 👍: ${datesPoll.options[0]!.title} (${yes.length ? `👍 from ${yes.join(", ")}` : "no 👍 yet"}); a majority locks it`);
    }
    return { title: "plan stages", lines };
  },
};
