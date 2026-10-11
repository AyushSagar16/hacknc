// When the group can go, from what each person said (date_window, blackout facts) and how long
// the trip is. Deterministic: every start day in range is scored by how many people are free for
// the whole stay; the best windows that don't overlap each other come back ranked (most people,
// then windows with a weekend in them, then earliest). Who can't make a window is named with why.
import { addDays, daysBetween } from "../clock.ts";

export interface PersonAvailability {
  personId: number;
  name: string;
  /** First day they can leave. */
  earliest?: string;
  /** Last day they can be back. */
  latest?: string;
  blackouts: { start: string; end: string }[];
}

export type Conflict =
  | { personId: number; name: string; kind: "starts_later"; date: string }
  | { personId: number; name: string; kind: "ends_earlier"; date: string }
  | { personId: number; name: string; kind: "blackout"; start: string; end: string };

export interface DateWindow {
  start: string;
  end: string;
  nights: number;
  /** People free for the whole stay. */
  available: number[];
  /** People who gave dates and can't make this one, with why. */
  conflicts: Conflict[];
  /** At least one Friday or Saturday night in the stay. */
  weekend: boolean;
}

export interface Availability {
  nights: number;
  /** Best windows first; all share the top head count. At most `max`, never overlapping. */
  candidates: DateWindow[];
  /** How many people the best window works for. */
  best: number;
  /** People who've said anything about their dates. */
  known: number[];
  /** People who haven't said anything about their dates. */
  unknown: { personId: number; name: string }[];
  /** The best window works for everyone who gave dates. */
  everyoneKnown: boolean;
}

export interface AvailabilityOpts {
  today: string;
  /** Preferred trip length. */
  nights: number;
  /** Shortest acceptable when nothing works at `nights` (default: 2 or `nights`, whichever is smaller). */
  minNights?: number;
  /** Search this far past the first possible start when nobody gave an end date. Default 90. */
  horizonDays?: number;
  /** Most windows to return. Default 3. */
  max?: number;
}

const MAX_SPAN_DAYS = 366;

export function hasDates(p: PersonAvailability): boolean {
  return Boolean(p.earliest || p.latest || p.blackouts.length);
}

/** Whether someone is free for [start, end] (both days on the trip), and if not, why. */
export function conflictFor(p: PersonAvailability, start: string, end: string): Conflict | null {
  if (p.earliest && p.earliest > start) return { personId: p.personId, name: p.name, kind: "starts_later", date: p.earliest };
  if (p.latest && p.latest < end) return { personId: p.personId, name: p.name, kind: "ends_earlier", date: p.latest };
  const clash = p.blackouts.find((b) => !(end < b.start || start > b.end));
  if (clash) return { personId: p.personId, name: p.name, kind: "blackout", start: clash.start, end: clash.end };
  return null;
}

const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();

/** A stay of `nights` from `start` includes a Friday or Saturday night. */
export function hasWeekendNight(start: string, nights: number): boolean {
  for (let i = 0; i < nights; i++) {
    const d = weekday(addDays(start, i));
    if (d === 5 || d === 6) return true;
  }
  return false;
}

function scoreWindows(people: PersonAvailability[], nights: number, opts: AvailabilityOpts): DateWindow[] {
  const known = people.filter(hasDates);
  const earliests = known.map((p) => p.earliest).filter((d): d is string => Boolean(d));
  const latests = known.map((p) => p.latest).filter((d): d is string => Boolean(d));
  const firstDay = addDays(opts.today, 1);
  let lo = earliests.length ? earliests.reduce((a, b) => (a < b ? a : b)) : firstDay;
  if (lo < firstDay) lo = firstDay;
  const lastEnd = latests.length ? latests.reduce((a, b) => (a > b ? a : b)) : addDays(lo, (opts.horizonDays ?? 90) + nights);
  const span = Math.min(daysBetween(lo, lastEnd) - nights, MAX_SPAN_DAYS);
  const out: DateWindow[] = [];
  for (let offset = 0; offset <= span; offset++) {
    const start = addDays(lo, offset);
    const end = addDays(start, nights);
    const available: number[] = [];
    const conflicts: Conflict[] = [];
    for (const p of known) {
      const c = conflictFor(p, start, end);
      if (c) conflicts.push(c);
      else available.push(p.personId);
    }
    if (available.length) out.push({ start, end, nights, available, conflicts, weekend: hasWeekendNight(start, nights) });
  }
  return out;
}

/** Most people first, then a weekend in the stay, then earliest. */
export function rankWindows(windows: DateWindow[]): DateWindow[] {
  return [...windows].sort((a, b) => b.available.length - a.available.length || Number(b.weekend) - Number(a.weekend) || (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

const overlaps = (a: DateWindow, b: DateWindow) => !(a.end <= b.start || b.end <= a.start);

export function findDateWindows(people: PersonAvailability[], opts: AvailabilityOpts): Availability {
  const known = people.filter(hasDates);
  const unknown = people.filter((p) => !hasDates(p)).map((p) => ({ personId: p.personId, name: p.name }));
  const max = Math.max(1, opts.max ?? 3);
  const preferred = Math.max(1, Math.round(opts.nights));
  const shortest = Math.max(1, Math.min(preferred, opts.minNights ?? 2));
  const empty: Availability = { nights: preferred, candidates: [], best: 0, known: known.map((p) => p.personId), unknown, everyoneKnown: false };
  if (known.length === 0) return empty;

  // Try the preferred length first; if it doesn't fit everyone who gave dates, a shorter stay
  // that does fit everyone wins over a longer one that leaves someone out.
  let chosen: { nights: number; windows: DateWindow[] } | undefined;
  for (let n = preferred; n >= shortest; n--) {
    const windows = scoreWindows(people, n, opts);
    if (!windows.length) continue;
    const top = Math.max(...windows.map((w) => w.available.length));
    if (!chosen || top > Math.max(...chosen.windows.map((w) => w.available.length))) chosen = { nights: n, windows };
    if (top === known.length) break;
  }
  if (!chosen) return empty;

  const ranked = rankWindows(chosen.windows);
  const best = ranked[0]!.available.length;
  const picked: DateWindow[] = [];
  for (const w of ranked) {
    if (w.available.length < best || picked.length >= max) break;
    if (picked.some((p) => overlaps(p, w))) continue;
    picked.push(w);
  }
  return { nights: chosen.nights, candidates: picked, best, known: known.map((p) => p.personId), unknown, everyoneKnown: best === known.length };
}
