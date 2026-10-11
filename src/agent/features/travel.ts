// Getting there: once where and when are settled, one rundown of how each person travels (drive
// or fly, hours, their gas share or fare, carpools for drivers from the same area, Google Flights
// links), saved per person in travel_plans. "i'll drive" / "i'll fly" overrides one person and is
// kept when the plan is recomputed. Travel is each person's own cost, not the shared trip costs.
import { formatUsd } from "../../money/cents.ts";
import { buildConstraints } from "../../trips/constraints.ts";
import { tripDestination } from "../../trips/place.ts";
import { liveFlightFares } from "../../trips/pricing.ts";
import { getStages, setStage } from "../../trips/stages.ts";
import { planTravel, saveTravelPlans, travelOverrides, travelPlansFor, type TravelLeg, type TravelMember, type TravelMode } from "../../trips/travel.ts";
import { q } from "../../db/pool.ts";
import type { Feature, TurnCtx } from "../feature.ts";
import type { Figure } from "../figures.ts";
import { ToolError, say, str, type Tool } from "../tools.ts";
import { nameList } from "./planning.ts";
import { pricingDeps } from "./proposals.ts";

const first = (label: string) => label.toLowerCase().split(/\s+/)[0] ?? label.toLowerCase();
const hoursText = (h: number | null) => (h === null ? "" : `~${Number.isInteger(h) ? h : h.toFixed(1)}h`);

/** Everyone in the group, as the travel planner needs them. */
async function travelMembers(tc: TurnCtx): Promise<TravelMember[]> {
  const view = await tc.view();
  const built = buildConstraints(view, [], { tripStart: tc.trip.start_date, tripEnd: tc.trip.end_date });
  const overrides = await travelOverrides(tc.trip.id);
  return view.members.map((m) => {
    const c = built.group.members.find((x) => x.personId === m.personId);
    return {
      personId: m.personId,
      name: first(m.label),
      origin: m.profile.homeCity?.value,
      noFlying: c?.noFlying,
      maxDriveHours: c?.maxDriveHours,
      override: overrides.get(m.personId),
    };
  });
}

export function travelFigures(legs: { name: string; mode: TravelMode; costCents: number | null; costSource: "estimate" | "live" }[]): Figure[] {
  return legs
    .filter((l) => l.costCents !== null && l.costCents > 0)
    .map((l) => ({
      cents: l.costCents!,
      label: `${l.name}'s travel (${l.mode === "drive" ? "gas share" : l.costSource === "live" ? "live fare" : "est. fare"})`,
      source: l.costSource === "live" ? "live:serpapi" : "estimate:travel",
      visibility: "public" as const,
    }));
}

/** One person's line in the rundown. */
export function legLine(l: TravelLeg, all: TravelLeg[]): string {
  if (l.problem === "no_home") return `${l.name}: need to know where you're leaving from`;
  if (l.mode === "drive") {
    if (l.hours === null) return `${l.name}: no road there and no flying, let's figure that one out`;
    const gas = l.costCents ? `, ~${formatUsd(l.costCents)}${l.carpoolWith.length ? " each" : ""} for gas` : "";
    if (l.carpoolWith.length) {
      const car = [l, ...l.carpoolWith.map((id) => all.find((x) => x.personId === id)).filter((x): x is TravelLeg => Boolean(x))];
      const origins = [...new Set(car.map((x) => x.origin?.toLowerCase()).filter(Boolean))];
      return `${nameList(car.map((x) => x.name))}: carpool${origins.length ? ` from ${origins.join("/")}` : ""}, ${hoursText(l.hours)}${gas}`;
    }
    return `${l.name}: drive${l.origin ? ` from ${l.origin.toLowerCase()}` : ""}, ${hoursText(l.hours)}${gas}`;
  }
  const fare = l.costCents ? `, ~${formatUsd(l.costCents)} round trip ${l.costSource === "live" ? "(live fare)" : "(est.)"}` : "";
  const note = l.problem === "no_road" ? " (no road there)" : "";
  return `${l.name}: fly from ${(l.origin ?? l.originIata ?? "home").toLowerCase()}${fare}${note}`;
}

/** The whole rundown: one line per person (carpools share a line), flight links, the personal-cost note. */
export function rundownText(placeName: string, legs: TravelLeg[]): string {

  const lines: string[] = [];
  const seenCars = new Set<string>();
  for (const l of legs) {
    if (l.carpoolGroup) {
      if (seenCars.has(l.carpoolGroup)) continue;
      seenCars.add(l.carpoolGroup);
    }
    lines.push(`- ${legLine(l, legs)}`);
  }
  const links = legs.filter((l) => l.mode === "fly" && l.link).map((l) => `✈️ ${l.name} from ${(l.originIata ?? "").toLowerCase()}: ${l.link}`);
  const icon = legs.some((l) => l.mode === "drive") ? "🚗" : "✈️";
  return [`how everyone gets to ${placeName.toLowerCase()} ${icon}`, ...lines, ...links, `travel's on each of you, separate from the shared costs. say "i'll drive" or "i'll fly" to switch`].join("\n");
}

/** Compute, save and register everyone's travel. Throws a ToolError when where/when isn't settled. */
export async function computeTravel(tc: TurnCtx): Promise<{ legs: TravelLeg[]; placeName: string }> {
  const dest = tripDestination(tc.trip);
  if (!dest || !tc.trip.destination_name) throw new ToolError("no destination is locked yet; settle where first");
  if (!tc.trip.start_date || !tc.trip.end_date) throw new ToolError("the trip has no dates yet; settle when first (find_dates)");
  const dates = { start: tc.trip.start_date, end: tc.trip.end_date };
  const members = await travelMembers(tc);
  // Estimates first to see who flies, then live fares for them (when SerpApi is set up).
  let legs = planTravel(dest, members, { dates });
  const flyers = legs.filter((l) => l.mode === "fly" && l.originIata).map((l) => ({ personId: l.personId, originIata: l.originIata! }));
  if (flyers.length && dest.iata) {
    const fares = await liveFlightFares(dest.iata, flyers, dates, pricingDeps());
    if (fares.size) legs = planTravel(dest, members, { dates, fares });
  }
  await tc.nonCancellable();
  await saveTravelPlans(tc.trip.id, legs, tc.now);
  tc.figures.addAll(travelFigures(legs));
  const complete = legs.every((l) => !l.problem || l.problem === "no_road");
  await setStage(tc.trip.id, "travel", complete ? "decided" : "in_progress", { force: !complete });
  return { legs, placeName: tc.trip.destination_name };
}

/** Post the rundown (used by plan_travel and when a dates poll settles a trip that already has a place). */
export async function postTravelPlan(tc: TurnCtx): Promise<TravelLeg[]> {
  const { legs, placeName } = await computeTravel(tc);
  say(tc, rundownText(placeName, legs));
  return legs;
}

/** "i'll drive" for one person: save it, recompute everyone (carpools change), post their line. */
async function setMode(tc: TurnCtx, personId: number, mode: TravelMode): Promise<{ line: string | null; legs: TravelLeg[] }> {
  await tc.nonCancellable();
  await q(
    `INSERT INTO travel_plans (trip_id, person_id, mode, overridden, updated_at) VALUES ($1,$2,$3,true,$4)
     ON CONFLICT (trip_id, person_id) DO UPDATE SET mode = EXCLUDED.mode, overridden = true, updated_at = EXCLUDED.updated_at`,
    [tc.trip.id, personId, mode, tc.now],
  );
  const stages = await getStages(tc.trip.id);
  if (stages.location !== "decided" || !tc.trip.start_date || !tc.trip.end_date || !tripDestination(tc.trip)) return { line: null, legs: [] };
  const { legs } = await computeTravel(tc);
  const mine = legs.find((l) => l.personId === personId);
  if (!mine) return { line: null, legs };
  if (mode === "drive" && mine.problem === "no_road") {
    // Can't drive there: undo the override so the plan stays honest.
    await q(`UPDATE travel_plans SET overridden = false WHERE trip_id = $1 AND person_id = $2`, [tc.trip.id, personId]);
    throw new ToolError(`there's no road trip to ${tc.trip.destination_name} from ${mine.origin ?? "their city"}; they'll have to fly`);
  }
  return { line: legLine(mine, legs), legs };
}

const I_WILL = /^\W*(?:(?:ok|okay|actually|nah|yeah|wait),?\s+)*i(?:['’]ll| will|['’]m| am|ll|m)\s+(?:just\s+|gonna\s+|going to\s+)?(drive|driving|fly|flying)(?:\s+(?:there|down|up|instead|myself|tbh))*\W*$/i;

const planTravelTool: Tool = {
  soloPost: true,
  decl: {
    name: "plan_travel",
    description:
      "Once the place and dates are settled, work out how everyone gets there: who drives (hours, their gas share, carpools for people leaving from the same area) and who flies (estimated or live fare plus a Google Flights link). Posts one rundown itself and saves it. Travel is each person's own cost.",
    parameters: { type: "object", properties: {} },
  },
  async run(_args, ctx) {
    const tc = ctx as TurnCtx;
    const legs = await postTravelPlan(tc);
    const missing = legs.filter((l) => l.problem === "no_home").map((l) => l.name);
    return {
      ok: true,
      data: { legs: legs.map((l) => ({ name: l.name, mode: l.mode, hours: l.hours, cost: l.costCents === null ? null : formatUsd(l.costCents), carpool: l.carpoolGroup })) },
      next: missing.length ? `the rundown was posted; ${nameList(missing)} still need to say where they're leaving from (ask_for_missing_info), otherwise NO_REPLY` : "the rundown was posted; reply NO_REPLY",
    };
  },
};

const setTravelModeTool: Tool = {
  decl: {
    name: "set_travel_mode",
    description: "One person switches how they get there (\"i'll drive\", \"actually i'm flying\"). Saves it, redoes carpools, and says their new plan in one line.",
    parameters: {
      type: "object",
      properties: { member: { type: "string", description: "first name, or \"me\" for the sender" }, mode: { type: "string", enum: ["drive", "fly"] } },
      required: ["member", "mode"],
    },
  },
  async run(args, ctx) {
    const tc = ctx as TurnCtx;
    const who = tc.resolve(str(args.member) ?? "me") ?? tc.senderId ?? undefined;
    if (who === undefined) throw new ToolError(`unknown member ${String(args.member)}`);
    const mode = args.mode === "drive" || args.mode === "fly" ? args.mode : undefined;
    if (!mode) throw new ToolError("mode is drive or fly");
    const { line } = await setMode(tc, who, mode);
    if (line) say(tc, `got it, ${line}`);
    return { ok: true, next: line ? "their new plan was posted; reply NO_REPLY" : `saved: ${tc.label(who)} will ${mode}. it's used once the place and dates are settled; say so in a few words` };
  },
};

export const travelFeature: Feature = {
  name: "travel",
  tools: [planTravelTool, setTravelModeTool],

  async fastPath(msg, tc) {
    if (msg.kind !== "text" || msg.person_id === null || !msg.speakable) return false;
    const m = I_WILL.exec(msg.text);
    if (!m) return false;
    // Only once there's a travel plan to change; before that it's just chatter for extraction.
    if ((await travelPlansFor(tc.trip.id)).length === 0) return false;
    const mode: TravelMode = /^dr/i.test(m[1]!) ? "drive" : "fly";
    tc.senderId = msg.person_id;
    try {
      const { line } = await setMode(tc, msg.person_id, mode);
      if (line) say(tc, `got it, ${line}`);
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      say(tc, err.message);
    }
    return true;
  },

  async figures(tc) {
    const rows = await travelPlansFor(tc.trip.id);
    return travelFigures(rows.map((r) => ({ name: first(tc.label(r.person_id)), mode: r.mode, costCents: r.est_cost_cents, costSource: r.cost_source })));
  },

  async situation(tc) {
    const rows = await travelPlansFor(tc.trip.id);
    if (!rows.length) return null;
    const lines = rows.map((r) => {
      const cost = r.est_cost_cents ? ` ${formatUsd(r.est_cost_cents)} ${r.mode === "drive" ? "gas share" : r.cost_source === "live" ? "live fare" : "est. fare"}` : "";
      const pool = r.carpool_group ? ` (carpool ${r.carpool_group})` : "";
      return `- ${tc.label(r.person_id)}: ${r.mode}${r.origin ? ` from ${r.origin}` : ""}${r.hours ? ` ~${r.hours}h` : ""}${cost}${pool}${r.overridden ? " (their choice)" : ""}`;
    });
    return { title: "travel (each person's own cost, not shared)", lines: [...lines, `to switch someone: set_travel_mode. to redo it after a change: plan_travel`] };
  },
};
