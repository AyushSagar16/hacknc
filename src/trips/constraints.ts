// Turns the live picture of the group (extracted preferences + budgets) into the hard
// constraints and soft preferences the destination engine takes. Deterministic.
import type { GroupView } from "../profile/groupView.ts";
import { effectiveCents, type BudgetRow } from "../nessie/budgets.ts";
import { resolveHome } from "./catalog.ts";
import type { GroupConstraints, MemberConstraints } from "./filter.ts";
import type { MemberPrefs } from "./score.ts";

export interface Built {
  group: GroupConstraints;
  prefs: MemberPrefs[];
  dates: { start: string; end: string } | null;
  notes: string[];
}

export function buildConstraints(
  view: GroupView,
  budgets: BudgetRow[],
  opts: { tripStart?: string | null; tripEnd?: string | null; nights?: number; tier?: "budget" | "mid" } = {},
): Built {
  const byPerson = new Map(budgets.map((b) => [b.person_id, b]));
  const notes: string[] = [];
  const members: MemberConstraints[] = [];
  const prefs: MemberPrefs[] = [];
  for (const m of view.members) {
    const p = m.profile;
    const home = p.homeCity ? resolveHome(p.homeCity.value) : undefined;
    if (p.homeCity && !home) notes.push(`couldn't place ${m.label}'s home city "${p.homeCity.value}", assumed the southeast`);
    const budget = byPerson.get(m.personId);
    const ceilings = [budget ? effectiveCents(budget) : null, p.budgetCeilingUsd ? Math.round(p.budgetCeilingUsd.value * 100) : null].filter((c): c is number => typeof c === "number" && c > 0);
    const limit = (kind: string) => p.travelLimits.find((l) => l.value.kind === kind);
    members.push({
      personId: m.personId,
      name: m.label,
      homeRegion: home?.region,
      homeAirport: home?.iata,
      budgetCeilingCents: ceilings.length ? Math.min(...ceilings) : undefined,
      dietary: p.dietary.map((d) => d.value),
      vetoes: [...p.vetoes.map((v) => v.value), ...p.tooExpensive.map((t) => t.value), ...p.dislikes.filter((d) => d.explicit && d.confidence >= 0.8).map((d) => d.value)],
      noFlying: Boolean(limit("no_flying")),
      maxDriveHours: limit("max_drive_hours")?.value.hours ?? undefined,
      maxFlightHours: limit("max_flight_hours")?.value.hours ?? undefined,
      noPassport: Boolean(limit("no_passport")),
      mobility: limit("low_mobility") ? "low" : "normal",
    });
    prefs.push({
      personId: m.personId,
      likesTags: p.likes.map((l) => l.value),
      namedDestinations: p.wants.map((w) => w.value),
      dislikesTags: p.dislikes.map((d) => d.value),
    });
  }
  const dates = opts.tripStart && opts.tripEnd ? { start: opts.tripStart, end: opts.tripEnd } : view.dates ? { start: view.dates.start, end: view.dates.end } : null;
  const nights = opts.nights ?? (dates ? Math.max(1, Math.round((Date.parse(dates.end) - Date.parse(dates.start)) / 86_400_000)) : view.nights.suggested);
  const ceilings = members.map((m) => m.budgetCeilingCents).filter((c): c is number => typeof c === "number");
  // College-trip default is budget tier; mid only when everyone's budget is comfortably high.
  const tier = opts.tier ?? (ceilings.length && Math.min(...ceilings) >= 160_000 ? "mid" : "budget");
  return { group: { members, startDate: dates?.start, endDate: dates?.end, nights, tier }, prefs, dates, notes };
}

/** Limits the group asked for out loud this time ("anything drivable", "under 800 each"). */
export interface GroupAsk {
  /** Everyone drives (implied by maxDriveHours). */
  driveOnly?: boolean;
  maxDriveHours?: number;
  maxPerPersonUsd?: number;
}

/** Fold a group-wide ask into every member's own limits (the tighter one wins). */
export function applyGroupAsk(group: GroupConstraints, ask: GroupAsk): GroupConstraints {
  const driveOnly = Boolean(ask.driveOnly) || (ask.maxDriveHours !== undefined && ask.maxDriveHours > 0);
  const capCents = ask.maxPerPersonUsd && ask.maxPerPersonUsd > 0 ? Math.round(ask.maxPerPersonUsd * 100) : undefined;
  const members = group.members.map((m): MemberConstraints => {
    const next = { ...m };
    if (driveOnly) next.noFlying = true;
    if (ask.maxDriveHours && ask.maxDriveHours > 0) next.maxDriveHours = Math.min(m.maxDriveHours ?? Number.POSITIVE_INFINITY, ask.maxDriveHours);
    if (capCents !== undefined) next.budgetCeilingCents = Math.min(m.budgetCeilingCents ?? Number.POSITIVE_INFINITY, capCents);
    return next;
  });
  return { ...group, members };
}
