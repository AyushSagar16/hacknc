// The live picture of the group, computed deterministically from each person's profile:
// the date window everyone can do, who needs what, who vetoed what, who still owes info.
import { addDays, daysBetween } from "../clock.ts";
import { normPlace, type PersonProfile } from "./aggregate.ts";

export interface GroupMember {
  personId: number;
  label: string;
  profile: PersonProfile;
}

export interface GroupView {
  members: GroupMember[];
  window: { earliest: string | null; latest: string | null; conflict: boolean; knownFrom: number };
  /** A concrete start/end that fits the window, everyone's blackouts and trip length; null if unknown. */
  dates: { start: string; end: string; nights: number } | null;
  nights: { min: number | null; max: number | null; suggested: number };
  dietary: Map<string, string[]>;
  /** Kinds of food people like ("thai" → who); "anything" means no preference. */
  cuisines: Map<string, string[]>;
  cuisineDislikes: Map<string, string[]>;
  wants: Map<string, { name: string; people: string[] }>;
  vetoes: Map<string, { name: string; people: string[] }>;
  likes: Map<string, string[]>;
  dislikes: Map<string, string[]>;
  limits: { label: string; kind: string; hours: number | null }[];
  tooExpensive: Map<string, string[]>;
  missing: { personId: number; label: string; fields: ("dates" | "home_city")[] }[];
  majorityHasShared: boolean;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => m.set(k, [...(m.get(k) ?? []), v]);

export function groupView(members: GroupMember[], today: string): GroupView {
  const earliests = members.map((m) => m.profile.earliest?.value).filter((d): d is string => Boolean(d));
  const latests = members.map((m) => m.profile.latest?.value).filter((d): d is string => Boolean(d));
  let earliest = earliests.length ? earliests.reduce((a, b) => (a > b ? a : b)) : null;
  const latest = latests.length ? latests.reduce((a, b) => (a < b ? a : b)) : null;
  if (earliest && earliest < today) earliest = today;
  const conflict = Boolean(earliest && latest && earliest > latest);

  const mins = members.map((m) => m.profile.minNights?.value).filter((n): n is number => typeof n === "number");
  const maxs = members.map((m) => m.profile.maxNights?.value).filter((n): n is number => typeof n === "number");
  const minNights = mins.length ? Math.max(...mins) : null;
  const maxNights = maxs.length ? Math.min(...maxs) : null;
  // With no stated trip length, use the whole shared window (up to a week); otherwise 3 nights.
  const windowNights = earliest && latest && earliest <= latest ? daysBetween(earliest, latest) : null;
  const preferred = minNights === null && maxNights === null && windowNights ? Math.min(windowNights, 7) : 3;
  const suggested = Math.max(1, Math.min(maxNights ?? 7, Math.max(minNights ?? 1, preferred)));

  const blackouts = members.flatMap((m) => m.profile.blackouts.map((b) => b.value));
  const dates = earliest || latest ? pickDates(earliest ?? today, latest, suggested, blackouts) : null;

  const dietary = new Map<string, string[]>();
  const cuisines = new Map<string, string[]>();
  const cuisineDislikes = new Map<string, string[]>();
  const wants = new Map<string, { name: string; people: string[] }>();
  const vetoes = new Map<string, { name: string; people: string[] }>();
  const likes = new Map<string, string[]>();
  const dislikes = new Map<string, string[]>();
  const tooExpensive = new Map<string, string[]>();
  const limits: GroupView["limits"] = [];
  const missing: GroupView["missing"] = [];

  for (const m of members) {
    const p = m.profile;
    for (const d of p.dietary) push(dietary, d.value, m.label);
    for (const c of p.cuisines ?? []) push(cuisines, c.value, m.label);
    for (const c of p.cuisineDislikes ?? []) push(cuisineDislikes, c.value, m.label);
    for (const w of p.wants) {
      const key = normPlace(w.value);
      const entry = wants.get(key) ?? { name: w.value, people: [] };
      entry.people.push(m.label);
      wants.set(key, entry);
    }
    for (const v of p.vetoes) {
      const key = normPlace(v.value);
      const entry = vetoes.get(key) ?? { name: v.value, people: [] };
      entry.people.push(m.label);
      vetoes.set(key, entry);
    }
    for (const l of p.likes) push(likes, l.value, m.label);
    for (const d of p.dislikes) push(dislikes, d.value, m.label);
    for (const t of p.tooExpensive) push(tooExpensive, normPlace(t.value), m.label);
    for (const l of p.travelLimits) limits.push({ label: m.label, kind: l.value.kind, hours: l.value.hours });
    const fields: ("dates" | "home_city")[] = [];
    if (!p.earliest && !p.latest) fields.push("dates");
    if (!p.homeCity && !p.travelLimits.some((l) => l.value.kind === "no_flying")) fields.push("home_city");
    if (fields.length) missing.push({ personId: m.personId, label: m.label, fields });
  }

  const shared = members.length - missing.length;
  return {
    members,
    window: { earliest, latest, conflict, knownFrom: Math.max(earliests.length, latests.length) },
    dates,
    nights: { min: minNights, max: maxNights, suggested },
    dietary,
    cuisines,
    cuisineDislikes,
    wants,
    vetoes,
    likes,
    dislikes,
    limits,
    tooExpensive,
    missing,
    majorityHasShared: shared * 2 > members.length,
  };
}

/** Earliest start in [from, to] whose stay avoids every blackout; shrinks nights to fit a short window. */
export function pickDates(
  from: string,
  to: string | null,
  nights: number,
  blackouts: { start: string; end: string }[],
): { start: string; end: string; nights: number } | null {
  const windowNights = to ? daysBetween(from, to) : nights;
  if (windowNights < 1) return null;
  const n = Math.min(nights, windowNights);
  const limit = to ? daysBetween(from, to) - n : 90;
  for (let offset = 0; offset <= limit; offset++) {
    const start = addDays(from, offset);
    const end = addDays(start, n);
    const clash = blackouts.some((b) => !(end < b.start || start > b.end));
    if (!clash) return { start, end, nights: n };
  }
  return null;
}

/** Tag weights for itinerary drafting: likes count +1 per person, dislikes −1. */
export function interestWeights(view: GroupView): Record<string, number> {
  const w: Record<string, number> = {};
  for (const [tag, people] of view.likes) w[tag] = (w[tag] ?? 0) + people.length;
  for (const [tag, people] of view.dislikes) w[tag] = (w[tag] ?? 0) - people.length;
  return w;
}
