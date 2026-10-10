// Core planning: who still owes which detail (asked at most once each), trip dates, and the
// deterministic summary.
import { daysBetween } from "../../clock.ts";
import { recordAsk } from "../../profile/store.ts";
import { updateTrip } from "../../trips/state.ts";
import { startWeatherWatch } from "./weather.ts";
import type { Feature, TurnCtx } from "../feature.ts";
import { ToolError, say, str, strList, type Tool } from "../tools.ts";

/** "maya", "maya and leo", "maya, leo and priya". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The two things a plan needs from everyone, as list items. */
const FIELD_ITEM: Record<string, string> = {
  dates: "when you're free",
  home_city: "where you'd be leaving from",
};

/** One person missing one thing: aimed at them by name ("sai, when are you free?"). */
const ONE_ASK: Record<string, string[]> = {
  dates: ["{who}, when are you free?", "{who}, what dates work for you?"],
  home_city: ["{who}, where would you be leaving from?", "{who}, which city would you fly or drive out of?"],
};

/** Several people missing one thing: asked of the room, names at the end (never "name," first). */
const ROOM_ASK: Record<string, string[]> = {
  dates: ["when are you all free, {who}?", "what dates work for you, {who}?"],
  home_city: ["where would you each be leaving from, {who}?", "which cities are you leaving from, {who}?"],
};

/** Missing both: a short list beats one long sentence. */
const BOTH_ASK = [
  "to get this going i need two things from {who}:\n- {a}\n- {b}\nwhat've you got?",
  "quick one so i can start planning. {who}, can you send me:\n- {a}\n- {b}?",
  "before i pull options i need two things from {who}:\n- {a}\n- {b}\nwho's first?",
];

/** One person missing both. */
const ONE_BOTH_ASK = ["{who}, two quick ones: when are you free, and where would you be leaving from?", "{who}, when are you free, and which city would you leave from?"];

const pick = <T,>(options: T[], seed: number): T => options[Math.abs(seed) % options.length]!;

/**
 * The ask, as one message. Deterministic for a given chat and set of names, but varied across
 * chats so it doesn't read like a form. A message aimed at one person starts with their name
 * (addressed.ts reads that as "only they can answer"); one for several never does.
 */
export function askText(groups: { people: string[]; fields: string[] }[], everyone: boolean, seed: number): string {
  const line = (g: { people: string[]; fields: string[] }, i: number): string => {
    const who = g.people.length === 1 ? g.people[0]! : everyone && groups.length === 1 ? "everyone" : nameList(g.people);
    if (g.fields.length >= 2 && g.people.length === 1) return pick(ONE_BOTH_ASK, seed + i).replace("{who}", who);
    if (g.fields.length >= 2) {
      const [a, b] = g.fields.map((f) => FIELD_ITEM[f] ?? f);
      return pick(BOTH_ASK, seed + i).replace("{who}", who).replace("{a}", a!).replace("{b}", b!);
    }
    const field = g.fields[0]!;
    const options = g.people.length === 1 ? ONE_ASK[field] : ROOM_ASK[field];
    return pick(options ?? [`${FIELD_ITEM[field] ?? field}, {who}?`], seed + i).replace("{who}", who);
  };
  const lines = groups.map(line);
  return lines.length === 1 ? lines[0]! : `a couple things before i pull options:\n${lines.join("\n")}`;
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
}

export function formatRange(start: string, end: string): string {
  const a = formatDay(start);
  const b = formatDay(end);
  // "nov 12–16" within a month, "nov 28–dec 3" across months.
  return a.split(" ")[0] === b.split(" ")[0] ? `${a}–${b.split(" ")[1]}` : `${a}–${b}`;
}

const askForMissingInfo: Tool = {
  soloPost: true,
  decl: {
    name: "ask_for_missing_info",
    description:
      "Ask people for details the plan still needs (their dates, where they'd leave from). Each person is asked about each detail at most once ever; people already asked are skipped automatically. Posts the question itself.",
    parameters: {
      type: "object",
      properties: { people: { type: "array", items: { type: "string" }, description: "first names; omit to ask everyone still missing something" } },
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const view = await tc.view();
    const wanted = strList(args.people).map((n) => tc.resolve(n)).filter((id): id is number => id !== undefined);
    const targets = view.missing.filter((m) => wanted.length === 0 || wanted.includes(m.personId));
    const asks: { label: string; fields: string[] }[] = [];
    const skipped: string[] = [];
    for (const m of targets) {
      const fresh: string[] = [];
      for (const f of m.fields) if (await recordAsk(m.personId, tc.chat.id, f, tc.now)) fresh.push(f);
      if (fresh.length) asks.push({ label: (m.label.toLowerCase().split(/\s+/)[0] ?? m.label).trim(), fields: fresh });
      else skipped.push(m.label);
    }
    if (asks.length === 0) return { ok: true, data: { asked: [], alreadyAsked: skipped }, next: "everyone missing info was already asked once; don't ask again, plan with what you have" };
    // Group people missing the same things into one line.
    const byFields = new Map<string, string[]>();
    for (const a of asks) byFields.set(a.fields.join("+"), [...(byFields.get(a.fields.join("+")) ?? []), a.label]);
    const groups = [...byFields].map(([fields, people]) => ({ people, fields: fields.split("+") }));
    const everyone = asks.length === tc.members.length && asks.length > 1;
    const text = askText(groups, everyone, tc.chat.id + asks.length);
    say(tc, text);
    return { ok: true, posted: [text], data: { asked: asks.map((a) => a.label), alreadyAsked: skipped } };
  },
};

const setTripDates: Tool = {
  decl: {
    name: "set_trip_dates",
    description: "Set the trip's dates once the group has agreed on them (or a majority has). Dates are YYYY-MM-DD.",
    parameters: {
      type: "object",
      properties: { start: { type: "string" }, end: { type: "string" } },
      required: ["start", "end"],
    },
  },
  async run(args, ctx) {
    const start = str(args.start);
    const end = str(args.end);
    if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new ToolError("dates must be YYYY-MM-DD");
    if (start < ctx.today) throw new ToolError(`start ${start} is in the past (today is ${ctx.today})`);
    const nights = daysBetween(start, end);
    if (nights < 1 || nights > 21) throw new ToolError("a trip is 1 to 21 nights");
    ctx.trip = await updateTrip(ctx.trip.id, { start_date: start, end_date: end });
    // A locked trip watches the forecast for its dates; restart the watch for the new ones.
    if (ctx.trip.status === "locked" || ctx.trip.status === "ongoing") await startWeatherWatch(ctx.trip);
    return { ok: true, data: { start, end, nights }, next: "dates saved; mention them in one line if helpful" };
  },
};

export const planningFeature: Feature = {
  name: "planning",
  tools: [askForMissingInfo, setTripDates],
  async hints(tc) {
    const view = await tc.view();
    const out: string[] = [];
    if (view.window.conflict) out.push("people's date windows don't overlap — the plan is stuck on dates");
    if (tc.trip.status === "planning" && view.majorityHasShared && !tc.trip.destination_name) out.push("a majority has shared dates and home cities; options could be proposed now");
    return out;
  },
  async summary(tc) {
    const view = await tc.view();
    const t = tc.trip;
    const lines: string[] = [];
    if (t.destination_name) lines.push(`destination: ${t.destination_name}${t.status === "locked" ? " (locked in)" : ""}`);
    if (t.start_date && t.end_date) lines.push(`dates: ${formatRange(t.start_date, t.end_date)}`);
    else if (view.dates) lines.push(`dates that work so far: ${formatRange(view.dates.start, view.dates.end)}`);
    else if (view.window.conflict) lines.push("dates: windows don't overlap yet");
    const vetoes = [...view.vetoes.values()].map((v) => `${v.name} (${v.people.join(", ")})`);
    if (vetoes.length) lines.push(`ruled out: ${vetoes.join(", ")}`);
    const diets = [...view.dietary].map(([need, people]) => `${need.replace(/_/g, " ")} (${people.join(", ")})`);
    if (diets.length) lines.push(`food: ${diets.join(", ")}`);
    if (view.limits.length) lines.push(`limits: ${view.limits.map((l) => `${l.label} ${l.kind.replace(/_/g, " ")}`).join(", ")}`);
    if (view.missing.length) {
      const what = (fields: string[]) => fields.map((f) => (f === "home_city" ? "home city" : f)).join(" + ");
      lines.push(`still need: ${view.missing.map((m) => `${m.label.toLowerCase()}'s ${what(m.fields)}`).join(", ")}${view.majorityHasShared ? " (enough of us have shared to keep going)" : ""}`);
    }
    return lines;
  },
};
