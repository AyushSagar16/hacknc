// Check cadence per window, trip-end cutoff, time zones, and alert cooldown / daily cap / storm bypass.
import { describe, expect, it } from "vitest";
import { nextCheckAt, shouldAlert, startOfDay, type AlertRecord } from "../../src/weather/cadence.ts";
import type { Change, ChangeKind, Severity } from "../../src/weather/diff.ts";

const H = 3_600_000;
const at = (iso: string) => new Date(iso);
const trip = { start: "2026-11-20", end: "2026-11-22" };

describe("nextCheckAt", () => {
  it("checks daily while the trip is beyond the forecast", () => {
    const now = at("2026-10-10T15:00:00Z"); // 41 days out
    expect(nextCheckAt(now, trip)).toEqual(at("2026-10-11T15:00:00Z"));
  });

  it("wakes exactly when the start day enters the 16-day forecast", () => {
    const now = at("2026-11-04T15:00:00Z"); // 16 days out; forecast reaches the 20th from the 5th
    expect(nextCheckAt(now, trip)).toEqual(at("2026-11-05T00:00:00Z"));
  });

  it("uses the destination's midnight for that wake-up", () => {
    const ny = { ...trip, timeZone: "America/New_York" };
    expect(nextCheckAt(at("2026-11-04T20:00:00Z"), ny)).toEqual(at("2026-11-05T05:00:00Z"));
  });

  it.each([
    ["2026-11-05T09:00:00Z", 15, 12],
    ["2026-11-09T09:00:00Z", 11, 12],
    ["2026-11-10T09:00:00Z", 10, 6],
    ["2026-11-16T09:00:00Z", 4, 6],
    ["2026-11-17T09:00:00Z", 3, 1],
    ["2026-11-19T09:00:00Z", 1, 1],
    ["2026-11-20T09:00:00Z", 0, 1],
    ["2026-11-22T12:00:00Z", -2, 1],
  ])("at %s (%i days out) checks every %i h", (iso, _daysOut, hours) => {
    const now = at(iso);
    expect(nextCheckAt(now, trip)?.getTime()).toBe(now.getTime() + hours * H);
  });

  it("returns null once the trip is over", () => {
    expect(nextCheckAt(at("2026-11-23T00:00:00Z"), trip)).toBeNull();
    expect(nextCheckAt(at("2026-12-01T00:00:00Z"), trip)).toBeNull();
  });

  it("returns null when the next check would land after the trip", () => {
    expect(nextCheckAt(at("2026-11-22T23:30:00Z"), trip)).toBeNull();
    expect(nextCheckAt(at("2026-11-22T22:30:00Z"), trip)).toEqual(at("2026-11-22T23:30:00Z"));
  });

  it("keeps watching through the last local evening of the trip", () => {
    const ny = { ...trip, timeZone: "America/New_York" };
    const now = at("2026-11-23T03:00:00Z"); // 22:00 on the 22nd in New York
    expect(nextCheckAt(now, trip)).toBeNull();
    expect(nextCheckAt(now, ny)).toEqual(at("2026-11-23T04:00:00Z"));
  });

  it("handles a one-day trip", () => {
    const day = { start: "2026-10-12", end: "2026-10-12" };
    expect(nextCheckAt(at("2026-10-12T10:00:00Z"), day)).toEqual(at("2026-10-12T11:00:00Z"));
    expect(nextCheckAt(at("2026-10-13T10:00:00Z"), day)).toBeNull();
  });
});

describe("startOfDay", () => {
  it("finds local midnight across DST changes", () => {
    expect(startOfDay("2026-03-08", "America/New_York")).toEqual(at("2026-03-08T05:00:00Z"));
    expect(startOfDay("2026-03-09", "America/New_York")).toEqual(at("2026-03-09T04:00:00Z"));
    expect(startOfDay("2026-11-01", "America/New_York")).toEqual(at("2026-11-01T04:00:00Z"));
    expect(startOfDay("2026-07-01", "Europe/Lisbon")).toEqual(at("2026-06-30T23:00:00Z"));
    expect(startOfDay("2026-07-01", "Asia/Kolkata")).toEqual(at("2026-06-30T18:30:00Z"));
    expect(startOfDay("2026-07-01", "UTC")).toEqual(at("2026-07-01T00:00:00Z"));
  });
});

function change(kind: ChangeKind, day = "2026-11-21", severity: Severity = 2): Change {
  const to = { day, category: "rain" as const, precipProbability: 70, tempMaxF: 70, windGustMph: 10 };
  return { day, kind, from: null, to, severity, summary: "saturday flipped to rain (70%)" };
}

const sent = (day: string, kind: string, iso: string): AlertRecord => ({ day, kind, sentAt: at(iso) });

describe("shouldAlert", () => {
  const now = at("2026-11-18T18:00:00Z");

  it("allows a first alert", () => {
    expect(shouldAlert(change("turned_wet"), [], now)).toBe(true);
  });

  it("blocks the same day and kind within 12 h", () => {
    const history = [sent("2026-11-21", "turned_wet", "2026-11-18T06:30:00Z")];
    expect(shouldAlert(change("turned_wet"), history, now)).toBe(false);
  });

  it("allows the same day and kind after 12 h", () => {
    const history = [sent("2026-11-21", "turned_wet", "2026-11-17T23:00:00Z")];
    expect(shouldAlert(change("turned_wet"), history, now)).toBe(true);
  });

  it("allows a different kind or a different day inside the cooldown", () => {
    const history = [sent("2026-11-21", "turned_wet", "2026-11-18T17:00:00Z")];
    expect(shouldAlert(change("wind"), history, now)).toBe(true);
    expect(shouldAlert(change("turned_wet", "2026-11-22"), history, now)).toBe(true);
  });

  it("caps weather alerts at two per UTC day", () => {
    const history = [
      sent("2026-11-20", "wind", "2026-11-18T01:00:00Z"),
      sent("2026-11-22", "temp_swing", "2026-11-18T09:00:00Z"),
    ];
    expect(shouldAlert(change("turned_wet"), history, now)).toBe(false);
    expect(shouldAlert(change("turned_wet"), history.slice(1), now)).toBe(true);
  });

  it("counts by the UTC date of sentAt, not a rolling 24 h", () => {
    const history = [
      sent("2026-11-20", "wind", "2026-11-17T20:00:00Z"),
      sent("2026-11-22", "temp_swing", "2026-11-17T23:59:00Z"),
    ];
    expect(shouldAlert(change("turned_wet"), history, now)).toBe(true);
  });

  it("lets a severity-3 storm past the daily cap", () => {
    const history = [
      sent("2026-11-20", "wind", "2026-11-18T01:00:00Z"),
      sent("2026-11-22", "turned_wet", "2026-11-18T09:00:00Z"),
    ];
    expect(shouldAlert(change("storm", "2026-11-21", 3), history, now)).toBe(true);
  });

  it("does not let a storm past its own 12 h cooldown", () => {
    const history = [sent("2026-11-21", "storm", "2026-11-18T08:00:00Z")];
    expect(shouldAlert(change("storm", "2026-11-21", 3), history, now)).toBe(false);
  });

  it("honours a custom policy", () => {
    const history = [sent("2026-11-21", "turned_wet", "2026-11-18T15:00:00Z")];
    expect(shouldAlert(change("turned_wet"), history, now, { cooldownMs: 2 * H })).toBe(true);
    expect(shouldAlert(change("wind"), history, now, { dailyCap: 1 })).toBe(false);
  });
});
