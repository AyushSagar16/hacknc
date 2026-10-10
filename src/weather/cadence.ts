// When to fetch a trip's forecast next (tighter as the trip nears), and whether a change may be sent now.
import { addDays, daysBetween, isoDate } from "../clock.ts";
import type { Change } from "./diff.ts";
import { FORECAST_DAYS } from "./openMeteo.ts";

const HOUR = 3_600_000;

/** The forecast covers today..today+15, so a day is first visible this many days ahead. */
export const LAST_FORECAST_OFFSET = FORECAST_DAYS - 1;

export interface TripWindow {
  start: string;
  end: string;
  /** IANA zone of the destination; trip dates are local there. Defaults to UTC. */
  timeZone?: string;
}

/**
 * Next forecast check, or null once the trip is over (or the next check would land after it).
 * Days out (trip start minus today, in the trip's zone):
 *   > 15  daily, or the local midnight the start day enters the forecast, whichever is sooner
 *   11-15 every 12 h   4-10 every 6 h   <= 3 (and during the trip) every hour
 */
export function nextCheckAt(now: Date, trip: TripWindow): Date | null {
  const tz = trip.timeZone ?? "UTC";
  const tripOver = startOfDay(addDays(trip.end, 1), tz).getTime();
  const t = now.getTime();
  if (t >= tripOver) return null;

  const daysOut = daysBetween(isoDate(now, tz), trip.start);
  let next: number;
  if (daysOut > LAST_FORECAST_OFFSET) {
    const entersForecast = startOfDay(addDays(trip.start, -LAST_FORECAST_OFFSET), tz).getTime();
    next = Math.min(t + 24 * HOUR, entersForecast);
  } else {
    next = t + intervalHours(daysOut) * HOUR;
  }
  return next >= tripOver ? null : new Date(next);
}

function intervalHours(daysOut: number): number {
  if (daysOut <= 3) return 1;
  if (daysOut <= 10) return 6;
  return 12;
}

export interface AlertRecord {
  day: string;
  kind: string;
  sentAt: Date;
}

export interface AlertPolicy {
  /** No repeat of the same (day, kind) inside this window. Default 12 h. */
  cooldownMs?: number;
  /** Weather alerts per UTC calendar day across the trip. Default 2. */
  dailyCap?: number;
}

/** Cooldown per (day, kind), a daily cap on all weather alerts; severity-3 storms skip only the cap. */
export function shouldAlert(change: Change, history: AlertRecord[], now: Date, policy: AlertPolicy = {}): boolean {
  const cooldownMs = policy.cooldownMs ?? 12 * HOUR;
  const dailyCap = policy.dailyCap ?? 2;
  const t = now.getTime();

  const repeat = history.some(
    (h) => h.day === change.day && h.kind === change.kind && t - h.sentAt.getTime() < cooldownMs,
  );
  if (repeat) return false;
  if (change.kind === "storm" && change.severity === 3) return true;

  const today = utcDay(now);
  const sentToday = history.filter((h) => utcDay(h.sentAt) === today).length;
  return sentToday < dailyCap;
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The instant a calendar day begins in a time zone (DST-safe for zones that keep midnight). */
export function startOfDay(day: string, timeZone: string): Date {
  const wallMidnight = Date.parse(`${day}T00:00:00Z`);
  let t = wallMidnight - offsetMs(new Date(wallMidnight), timeZone);
  t = wallMidnight - offsetMs(new Date(t), timeZone);
  return new Date(t);
}

/** Zone offset from UTC at an instant, in ms (positive east of Greenwich). */
function offsetMs(at: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(at)) if (part.type !== "literal") p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}
