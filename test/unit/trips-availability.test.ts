// Date overlap: which windows the most people can make, who can't and why, and the messages
// find_dates posts.
import { describe, expect, it } from "vitest";
import { conflictFor, findDateWindows, hasWeekendNight, rankWindows, type PersonAvailability } from "../../src/trips/availability.ts";
import { conflictText, datesMessage } from "../../src/agent/features/stages.ts";

const TODAY = "2026-10-10";
const p = (personId: number, name: string, earliest?: string, latest?: string, blackouts: { start: string; end: string }[] = []): PersonAvailability => ({
  personId,
  name,
  ...(earliest ? { earliest } : {}),
  ...(latest ? { latest } : {}),
  blackouts,
});

describe("conflictFor", () => {
  const maya = p(1, "maya", "2026-11-10", "2026-11-20", [{ start: "2026-11-14", end: "2026-11-14" }]);
  it("is null when the whole stay fits", () => {
    expect(conflictFor(maya, "2026-11-10", "2026-11-13")).toBeNull();
  });
  it("says when they start later", () => {
    expect(conflictFor(maya, "2026-11-08", "2026-11-11")).toMatchObject({ kind: "starts_later", date: "2026-11-10" });
  });
  it("says when they have to be back earlier", () => {
    expect(conflictFor(maya, "2026-11-18", "2026-11-21")).toMatchObject({ kind: "ends_earlier", date: "2026-11-20" });
  });
  it("a blackout on any day of the stay (travel days included) conflicts", () => {
    expect(conflictFor(maya, "2026-11-11", "2026-11-14")).toMatchObject({ kind: "blackout", start: "2026-11-14" });
    expect(conflictFor(maya, "2026-11-14", "2026-11-17")).toMatchObject({ kind: "blackout" });
  });
  it("open-ended windows only bound one side", () => {
    expect(conflictFor(p(2, "leo", "2026-11-01"), "2027-03-01", "2027-03-05")).toBeNull();
    expect(conflictFor(p(2, "leo", undefined, "2026-11-30"), "2026-10-20", "2026-10-23")).toBeNull();
  });
});

describe("findDateWindows", () => {
  it("everyone with the same window: exactly one candidate", () => {
    const people = [p(1, "maya", "2026-11-12", "2026-11-16"), p(2, "leo", "2026-11-12", "2026-11-16"), p(3, "priya", "2026-11-12", "2026-11-16")];
    const r = findDateWindows(people, { today: TODAY, nights: 4 });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ start: "2026-11-12", end: "2026-11-16", nights: 4, available: [1, 2, 3], conflicts: [] });
    expect(r.everyoneKnown).toBe(true);
    expect(r.unknown).toEqual([]);
  });

  it("a wide shared window gives up to three non-overlapping options, weekends first", () => {
    const people = [p(1, "maya", "2026-11-02", "2026-11-29"), p(2, "leo", "2026-11-02", "2026-11-29")];
    const r = findDateWindows(people, { today: TODAY, nights: 3 });
    expect(r.candidates).toHaveLength(3);
    for (const w of r.candidates) expect(w.weekend).toBe(true);
    const sorted = [...r.candidates].sort((a, b) => (a.start < b.start ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.start >= sorted[i - 1]!.end).toBe(true);
  });

  it("no window fits everyone: the best one fits most and names who can't", () => {
    const people = [
      p(1, "maya", "2026-11-01", "2026-11-10"),
      p(2, "leo", "2026-11-01", "2026-11-10"),
      p(3, "priya", "2026-11-20", "2026-11-30"),
    ];
    const r = findDateWindows(people, { today: TODAY, nights: 3 });
    expect(r.best).toBe(2);
    expect(r.everyoneKnown).toBe(false);
    const w = r.candidates[0]!;
    expect(w.available).toEqual([1, 2]);
    expect(w.conflicts).toEqual([{ personId: 3, name: "priya", kind: "starts_later", date: "2026-11-20" }]);
  });

  it("a blackout splits a window: the stay goes around it", () => {
    const people = [p(1, "maya", "2026-11-10", "2026-11-17"), p(2, "leo", "2026-11-10", "2026-11-17", [{ start: "2026-11-13", end: "2026-11-13" }])];
    const r = findDateWindows(people, { today: TODAY, nights: 3 });
    expect(r.best).toBe(2);
    for (const w of r.candidates) expect(w.start > "2026-11-13" || w.end < "2026-11-13").toBe(true);
  });

  it("people who said nothing about dates are listed, not counted against a window", () => {
    const r = findDateWindows([p(1, "maya", "2026-11-12", "2026-11-16"), p(2, "leo")], { today: TODAY, nights: 4 });
    expect(r.unknown).toEqual([{ personId: 2, name: "leo" }]);
    expect(r.known).toEqual([1]);
    expect(r.candidates[0]!.conflicts).toEqual([]);
    expect(r.everyoneKnown).toBe(true);
  });

  it("nobody has given dates: no candidates, everyone unknown", () => {
    const r = findDateWindows([p(1, "maya"), p(2, "leo")], { today: TODAY, nights: 3 });
    expect(r.candidates).toEqual([]);
    expect(r.unknown).toHaveLength(2);
  });

  it("only busy dates known: the person is free outside them", () => {
    const r = findDateWindows([p(1, "maya", undefined, undefined, [{ start: "2026-10-11", end: "2026-10-20" }])], { today: TODAY, nights: 2 });
    expect(r.candidates.length).toBeGreaterThan(0);
    for (const w of r.candidates) expect(w.start > "2026-10-20").toBe(true);
  });

  it("windows never start before tomorrow", () => {
    const r = findDateWindows([p(1, "maya", "2026-09-01", "2026-10-20"), p(2, "leo", "2026-09-01", "2026-10-20")], { today: TODAY, nights: 3 });
    for (const w of r.candidates) expect(w.start >= "2026-10-11").toBe(true);
  });

  it("a shorter stay that fits everyone beats a longer one that doesn't", () => {
    // The overlap is only 2 nights long; a 4-night trip would leave someone out.
    const people = [p(1, "maya", "2026-11-12", "2026-11-20"), p(2, "leo", "2026-11-05", "2026-11-14")];
    const r = findDateWindows(people, { today: TODAY, nights: 4 });
    expect(r.nights).toBe(2);
    expect(r.candidates[0]).toMatchObject({ start: "2026-11-12", end: "2026-11-14", available: [1, 2] });
  });

  it("never shortens below the group's minimum", () => {
    const people = [p(1, "maya", "2026-11-12", "2026-11-20"), p(2, "leo", "2026-11-05", "2026-11-14")];
    const r = findDateWindows(people, { today: TODAY, nights: 4, minNights: 3 });
    expect(r.nights).toBe(4);
    expect(r.best).toBe(1);
  });

  it("windows that touch on a travel day count as separate options", () => {
    const people = [p(1, "maya", "2026-11-06", "2026-11-12")];
    const r = findDateWindows(people, { today: TODAY, nights: 3, max: 3 });
    expect(r.candidates.length).toBe(2);
  });

  it("is deterministic", () => {
    const people = [p(1, "maya", "2026-11-02", "2026-11-29"), p(2, "leo", "2026-11-04", "2026-11-25", [{ start: "2026-11-14", end: "2026-11-16" }])];
    expect(findDateWindows(people, { today: TODAY, nights: 3 })).toEqual(findDateWindows(people, { today: TODAY, nights: 3 }));
  });
});

describe("ranking helpers", () => {
  it("knows a Friday or Saturday night", () => {
    expect(hasWeekendNight("2026-11-13", 2)).toBe(true); // fri
    expect(hasWeekendNight("2026-11-09", 3)).toBe(false); // mon–thu
  });

  it("ranks by head count, then weekend, then earliest", () => {
    const w = (start: string, n: number, weekend: boolean) => ({ start, end: start, nights: 1, available: Array.from({ length: n }, (_, i) => i), conflicts: [], weekend });
    const ranked = rankWindows([w("2026-11-01", 2, false), w("2026-11-09", 3, false), w("2026-11-05", 2, true), w("2026-11-03", 2, true)]);
    expect(ranked.map((x) => x.start)).toEqual(["2026-11-09", "2026-11-03", "2026-11-05", "2026-11-01"]);
  });
});

describe("the dates message", () => {
  const names = new Map([[1, "maya"], [2, "leo"], [3, "priya"]]);

  it("one pick: dates, who it works for, and the 👍 ask", () => {
    const text = datesMessage([{ start: "2026-11-12", end: "2026-11-16", nights: 4, available: [1, 2, 3], conflicts: [], weekend: true }], 3, names);
    expect(text).toBe("📅 nov 12–16 (4 nights) works for everyone\n👍 this to lock it in");
  });

  it("one pick that leaves someone out says who and why", () => {
    const text = datesMessage([{ start: "2026-11-12", end: "2026-11-15", nights: 3, available: [1, 2], conflicts: [{ personId: 3, name: "priya", kind: "blackout", start: "2026-11-14", end: "2026-11-15" }], weekend: true }], 3, names);
    expect(text).toContain("works for all but priya");
    expect(text).toContain("priya's busy nov 14–15");
  });

  it("several options are numbered with who each one works for", () => {
    const text = datesMessage(
      [
        { start: "2026-11-06", end: "2026-11-09", nights: 3, available: [1, 2, 3], conflicts: [], weekend: true },
        { start: "2026-11-20", end: "2026-11-23", nights: 3, available: [1, 2, 3], conflicts: [], weekend: true },
      ],
      3,
      names,
    );
    expect(text.split("\n")).toEqual(["a few dates work for everyone (3 nights) 👇", "1. nov 6–9: everyone", "2. nov 20–23: everyone"]);
  });

  it("conflict wording", () => {
    expect(conflictText({ personId: 1, name: "sam", kind: "ends_earlier", date: "2026-11-15" })).toBe("sam has to be back by nov 15");
    expect(conflictText({ personId: 1, name: "sam", kind: "starts_later", date: "2026-11-15" })).toBe("sam's free from nov 15");
    expect(conflictText({ personId: 1, name: "sam", kind: "blackout", start: "2026-11-15", end: "2026-11-15" })).toBe("sam's busy nov 15");
  });
});
