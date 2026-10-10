// Material change detection: each rule, first-look behavior, ordering and weekday summaries.
import { describe, expect, it } from "vitest";
import {
  detectChanges,
  snapshotsFromForecast,
  weekdayName,
  type DaySnapshot,
} from "../../src/weather/diff.ts";

const FRI = "2026-10-16";
const SAT = "2026-10-17";
const SUN = "2026-10-18";

function snap(day: string, over: Partial<DaySnapshot> = {}): DaySnapshot {
  return { day, category: "clear", precipProbability: 5, tempMaxF: 78, windGustMph: 12, ...over };
}

const map = (...snaps: DaySnapshot[]) => new Map(snaps.map((s) => [s.day, s]));

describe("weekdayName", () => {
  it("names the day from the date", () => {
    expect(weekdayName("2026-10-10")).toBe("saturday");
    expect(weekdayName(FRI)).toBe("friday");
    expect(weekdayName(SUN)).toBe("sunday");
    expect(weekdayName("2026-10-12")).toBe("monday");
  });
});

describe("detectChanges: turned_wet", () => {
  it("flags clear -> rain at >= 50%", () => {
    const [c, ...rest] = detectChanges(map(snap(SAT)), map(snap(SAT, { category: "rain", precipProbability: 70 })));
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ day: SAT, kind: "turned_wet", severity: 2, summary: "saturday flipped to rain (70%)" });
    expect(c!.from?.category).toBe("clear");
    expect(c!.to.category).toBe("rain");
  });

  it("flags cloudy -> snow", () => {
    const [c] = detectChanges(map(snap(SUN, { category: "cloudy" })), map(snap(SUN, { category: "snow", precipProbability: 80 })));
    expect(c).toMatchObject({ kind: "turned_wet", severity: 2, summary: "sunday flipped to snow (80%)" });
  });

  it("ignores rain below 50%", () => {
    expect(detectChanges(map(snap(SAT)), map(snap(SAT, { category: "rain", precipProbability: 45 })))).toEqual([]);
  });

  it("ignores rain with unknown probability", () => {
    expect(detectChanges(map(snap(SAT)), map(snap(SAT, { category: "rain", precipProbability: null })))).toEqual([]);
  });

  it("flags a marginal rain day that becomes likely", () => {
    const prev = map(snap(SAT, { category: "rain", precipProbability: 40 }));
    const [c] = detectChanges(prev, map(snap(SAT, { category: "rain", precipProbability: 75 })));
    expect(c).toMatchObject({ kind: "turned_wet", severity: 2, summary: "saturday's rain chance jumped to 75%" });
  });

  it("does not re-flag a day that was already wet", () => {
    const prev = map(snap(SAT, { category: "rain", precipProbability: 60 }));
    expect(detectChanges(prev, map(snap(SAT, { category: "rain", precipProbability: 90 })))).toEqual([]);
  });

  it("respects a custom threshold", () => {
    const next = map(snap(SAT, { category: "rain", precipProbability: 45 }));
    expect(detectChanges(map(snap(SAT)), next, { wetPrecipPct: 40 })[0]?.kind).toBe("turned_wet");
  });
});

describe("detectChanges: storm", () => {
  it("flags a dry day turning stormy as one severity-3 change", () => {
    const changes = detectChanges(map(snap(SAT)), map(snap(SAT, { category: "storm", precipProbability: 80 })));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "storm", severity: 3, summary: "saturday flipped to thunderstorms (80%)" });
  });

  it("flags rain escalating to storms", () => {
    const prev = map(snap(SAT, { category: "rain", precipProbability: 70 }));
    const [c] = detectChanges(prev, map(snap(SAT, { category: "storm", precipProbability: 85 })));
    expect(c).toMatchObject({ kind: "storm", severity: 3, summary: "saturday escalated to thunderstorms (85%)" });
  });

  it("does not repeat an ongoing storm", () => {
    const prev = map(snap(SAT, { category: "storm", precipProbability: 70 }));
    expect(detectChanges(prev, map(snap(SAT, { category: "storm", precipProbability: 90 })))).toEqual([]);
  });

  it("omits the percentage when it is unknown", () => {
    const [c] = detectChanges(map(snap(SAT)), map(snap(SAT, { category: "storm", precipProbability: null })));
    expect(c!.summary).toBe("saturday flipped to thunderstorms");
  });
});

describe("detectChanges: temp_swing", () => {
  it("flags a 12°F jump", () => {
    const [c] = detectChanges(map(snap(SAT, { tempMaxF: 78 })), map(snap(SAT, { tempMaxF: 90.4 })));
    expect(c).toMatchObject({ kind: "temp_swing", severity: 1, summary: "saturday jumped to 90° (was 78°)" });
  });

  it("flags a drop", () => {
    const [c] = detectChanges(map(snap(FRI, { tempMaxF: 74 })), map(snap(FRI, { tempMaxF: 58 })));
    expect(c).toMatchObject({ kind: "temp_swing", summary: "friday dropped to 58° (was 74°)" });
  });

  it("ignores an 11°F change and unknown temps", () => {
    expect(detectChanges(map(snap(SAT, { tempMaxF: 78 })), map(snap(SAT, { tempMaxF: 89 })))).toEqual([]);
    expect(detectChanges(map(snap(SAT, { tempMaxF: null })), map(snap(SAT, { tempMaxF: 40 })))).toEqual([]);
  });
});

describe("detectChanges: wind", () => {
  it("flags gusts newly at 40 mph", () => {
    const [c] = detectChanges(map(snap(SAT, { windGustMph: 25 })), map(snap(SAT, { windGustMph: 44.6 })));
    expect(c).toMatchObject({ kind: "wind", severity: 2, summary: "saturday gusts up to 45 mph" });
  });

  it("does not repeat gusts that were already high", () => {
    expect(detectChanges(map(snap(SAT, { windGustMph: 42 })), map(snap(SAT, { windGustMph: 50 })))).toEqual([]);
  });

  it("treats unknown previous gusts as calm", () => {
    expect(detectChanges(map(snap(SAT, { windGustMph: null })), map(snap(SAT, { windGustMph: 41 })))[0]?.kind).toBe("wind");
  });
});

describe("detectChanges: cleared_up", () => {
  it("flags rain clearing as informational", () => {
    const prev = map(snap(SAT, { category: "rain", precipProbability: 70 }));
    const [c] = detectChanges(prev, map(snap(SAT, { category: "clear", precipProbability: 10, tempMaxF: 78 })));
    expect(c).toMatchObject({ kind: "cleared_up", severity: 1, summary: "saturday cleared up (sunny, 78°)" });
  });

  it("flags a storm clearing to clouds", () => {
    const prev = map(snap(SUN, { category: "storm", precipProbability: 60 }));
    const [c] = detectChanges(prev, map(snap(SUN, { category: "cloudy", precipProbability: 20, tempMaxF: 70 })));
    expect(c).toMatchObject({ kind: "cleared_up", summary: "sunday cleared up (cloudy, 70°)" });
  });

  it("stays quiet when marginal rain we never flagged goes away", () => {
    const prev = map(snap(SAT, { category: "rain", precipProbability: 40 }));
    expect(detectChanges(prev, map(snap(SAT, { category: "cloudy", precipProbability: 20 })))).toEqual([]);
  });
});

describe("detectChanges: first look", () => {
  const next = map(
    snap(FRI),
    snap(SAT, { category: "rain", precipProbability: 70 }),
    snap(SUN, { category: "storm", precipProbability: 65 }),
    snap("2026-10-19", { category: "rain", precipProbability: 55 }),
    snap("2026-10-20", { category: "storm", precipProbability: 40 }),
    snap("2026-10-21", { windGustMph: 50, tempMaxF: 99 }),
  );

  it("reports only days that are already bad", () => {
    const changes = detectChanges(new Map(), next);
    expect(changes.map((c) => [c.day, c.kind, c.severity, c.from])).toEqual([
      [SAT, "turned_wet", 2, null],
      [SUN, "storm", 3, null],
    ]);
    expect(changes.map((c) => c.summary)).toEqual([
      "saturday's forecast shows rain (70%)",
      "sunday's forecast shows thunderstorms (65%)",
    ]);
  });

  it("treats a day newly inside the forecast window the same way", () => {
    const prev = map(snap(FRI));
    const changes = detectChanges(prev, map(snap(FRI), snap(SAT, { category: "rain", precipProbability: 50 })));
    expect(changes).toEqual([]);
    const bad = detectChanges(prev, map(snap(FRI), snap(SAT, { category: "rain", precipProbability: 60 })));
    expect(bad.map((c) => c.kind)).toEqual(["turned_wet"]);
  });

  it("ignores days in prev that have dropped out of next", () => {
    expect(detectChanges(map(snap(FRI, { category: "storm", precipProbability: 90 })), map(snap(SAT)))).toEqual([]);
  });
});

describe("detectChanges: ordering and combinations", () => {
  it("reports several kinds for one day, highest severity first", () => {
    const prev = map(snap(SAT, { tempMaxF: 80, windGustMph: 20 }));
    const next = map(snap(SAT, { category: "storm", precipProbability: 90, tempMaxF: 66, windGustMph: 48 }));
    expect(detectChanges(prev, next).map((c) => [c.kind, c.severity])).toEqual([
      ["storm", 3],
      ["wind", 2],
      ["temp_swing", 1],
    ]);
  });

  it("sorts by day regardless of map order", () => {
    const prev = map(snap(SUN), snap(FRI));
    const next = map(snap(SUN, { category: "rain", precipProbability: 80 }), snap(FRI, { category: "rain", precipProbability: 80 }));
    expect(detectChanges(prev, next).map((c) => c.day)).toEqual([FRI, SUN]);
  });

  it("returns nothing when nothing material changed", () => {
    const prev = map(snap(FRI), snap(SAT, { category: "cloudy" }));
    const next = map(snap(FRI, { tempMaxF: 82, precipProbability: 20 }), snap(SAT, { category: "clear" }));
    expect(detectChanges(prev, next)).toEqual([]);
  });
});

describe("snapshotsFromForecast", () => {
  it("classifies and keeps only the requested days", () => {
    const m = snapshotsFromForecast(
      [
        { day: FRI, weatherCode: 0, precipProbability: 2, tempMaxF: 81, tempMinF: 65, windGustMph: 10 },
        { day: SAT, weatherCode: 63, precipProbability: 70, tempMaxF: 72, tempMinF: 61, windGustMph: 22 },
        { day: SUN, weatherCode: 51, precipProbability: 9, tempMaxF: 70, tempMinF: 60, windGustMph: 18 },
      ],
      [SAT, SUN],
    );
    expect([...m.keys()]).toEqual([SAT, SUN]);
    expect(m.get(SAT)).toEqual({ day: SAT, category: "rain", precipProbability: 70, tempMaxF: 72, windGustMph: 22 });
    expect(m.get(SUN)?.category).toBe("cloudy");
  });
});
