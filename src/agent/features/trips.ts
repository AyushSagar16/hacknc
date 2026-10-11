// Several trips per chat. The chat works on one focused trip at a time; starting a new trip
// focuses it (with a fresh page), and switching moves the focus back. What people said about
// themselves (diet, home city, interests) carries over; where/when/how long is per trip.
import { createTrip, focusTrip, tripName, tripsForChat, type TripRow } from "../../trips/state.ts";
import type { Feature, TurnCtx } from "../feature.ts";
import { ToolError, str, type Tool } from "../tools.ts";
import { formatRange } from "./planning.ts";
import { announceSection } from "./site.ts";

function describe(t: TripRow, i: number): string {
  const when = t.start_date && t.end_date ? `, ${formatRange(t.start_date, t.end_date)}` : "";
  return `${tripName(t, i)} (${t.status}${when})`;
}

/** Match a trip by title or destination ("japan", "spring break", "the first one"). */
export function matchTrip(trips: TripRow[], name: string): TripRow | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  const ordinal = /^(?:the\s+)?(first|second|third|1st|2nd|3rd|\d+)(?:\s+one|\s+trip)?$/.exec(n);
  if (ordinal) {
    const idx = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2 }[ordinal[1]!] ?? Number(ordinal[1]) - 1;
    return trips[idx];
  }
  const names = trips.map((t, i) => ({ t, keys: [t.title, t.destination_name, `trip ${i + 1}`].filter((k): k is string => Boolean(k)).map((k) => k.toLowerCase()) }));
  return (
    names.find((x) => x.keys.includes(n))?.t ??
    names.find((x) => x.keys.some((k) => k.includes(n) || n.includes(k)))?.t
  );
}

const startTrip: Tool = {
  decl: {
    name: "start_trip",
    description:
      "Start a separate, additional trip in this chat (\"let's also plan japan for june\", \"new trip: spring break\"). The current trip is kept as is. Never use this to change the current trip's destination or dates. Posts the new trip's page link itself.",
    parameters: {
      type: "object",
      properties: { title: { type: "string", description: "short name the group would use: a place (\"japan\") or occasion (\"spring break\")" } },
      required: ["title"],
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const title = str(args.title)?.toLowerCase().slice(0, 60);
    if (!title) throw new ToolError("give the new trip a short title");
    const trips = await tripsForChat(tc.chat.id);
    const existing = matchTrip(trips, title);
    if (existing && existing.status !== "done") throw new ToolError(`there's already a trip called ${tripName(existing)}; use switch_trip to work on it`);
    await tc.nonCancellable();
    tc.trip = await createTrip(tc.chat.id, title);
    const linked = await announceSection(tc, "overview");
    return {
      ok: true,
      data: { trip: title, others: trips.map(describe) },
      next: `new trip "${title}" started${linked ? " and its page link was posted" : ""}; in one short line, ask for dates/home cities only if they're unknown`,
    };
  },
};

const switchTrip: Tool = {
  decl: {
    name: "switch_trip",
    description: "Switch which of this chat's trips you're working on, when the group starts talking about a different one. Posts that trip's page link.",
    parameters: { type: "object", properties: { trip: { type: "string", description: "the trip's title or destination" } }, required: ["trip"] },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const trips = await tripsForChat(tc.chat.id);
    const target = matchTrip(trips, str(args.trip) ?? "");
    if (!target) throw new ToolError(`no trip matches "${String(args.trip)}". trips: ${trips.map(describe).join("; ")}`);
    if (target.id === tc.trip.id) return { ok: true, next: `already working on ${tripName(target)}` };
    tc.trip = await focusTrip(tc.chat.id, target.id);
    const linked = await announceSection(tc, "overview");
    return { ok: true, data: { trip: describe(target, trips.indexOf(target)) }, next: `now on ${tripName(target)}${linked ? "; its page link was posted" : ""}` };
  },
};

export const tripsFeature: Feature = {
  name: "trips",
  tools: [startTrip, switchTrip],
  async situation(tc) {
    const trips = await tripsForChat(tc.chat.id);
    if (trips.length < 2) return null;
    const others = trips.map((t, i) => ({ t, i })).filter(({ t }) => t.id !== tc.trip.id);
    return {
      title: "other trips in this chat",
      lines: [
        `you're working on: ${describe(tc.trip, trips.findIndex((t) => t.id === tc.trip.id))}`,
        ...others.map(({ t, i }) => `- ${describe(t, i)}`),
        "if the group moves on to one of these, call switch_trip first",
      ],
    };
  },
};
