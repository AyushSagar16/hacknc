// Every timestamp Atlas writes comes from here, so the simulator can travel in time
// (weather cadence, installment reminders, "three weeks later" memory recall).

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock that runs at real speed from a movable offset. */
export class OffsetClock implements Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  set(at: Date): void {
    this.offsetMs = at.getTime() - Date.now();
  }
}

/** A frozen clock for unit tests. */
export class FixedClock implements Clock {
  constructor(private at: Date) {}

  now(): Date {
    return new Date(this.at.getTime());
  }

  advance(ms: number): void {
    this.at = new Date(this.at.getTime() + ms);
  }

  set(at: Date): void {
    this.at = new Date(at.getTime());
  }
}

let current: Clock = systemClock;

export function clock(): Clock {
  return current;
}

export function now(): Date {
  return current.now();
}

export function setClock(next: Clock): void {
  current = next;
}

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parse "+3d", "90m", "2h" into milliseconds. */
export function parseDuration(text: string): number {
  const match = /^\+?(\d+(?:\.\d+)?)\s*([smhdw])$/.exec(text.trim());
  if (!match) throw new Error(`Unrecognized duration "${text}" (try +3d, 6h, 90m, 30s)`);
  return Number(match[1]) * (UNITS[match[2]!] ?? 0);
}

/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function isoDate(at: Date, timeZone = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  return parts;
}

export function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
