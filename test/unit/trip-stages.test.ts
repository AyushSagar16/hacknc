// Trip stages: inference for older trips, the next stage to settle, reopen cascades, and the
// lines the agent sees.
import { describe, expect, it } from "vitest";
import { cascadeReopen, describeStages, inferStages, nextStage, stagesOf, type StageMap } from "../../src/trips/stages.ts";
import { stageLines } from "../../src/agent/features/stages.ts";
import { stagesFor } from "../../src/site/snapshot.ts";
import type { TripRow } from "../../src/trips/state.ts";

const trip = (over: Partial<TripRow> = {}) => ({
  status: "planning" as TripRow["status"],
  destination_name: null as string | null,
  start_date: null as string | null,
  end_date: null as string | null,
  stay: null,
  stages: {},
  ...over,
});

const all = (s: StageMap[keyof StageMap]): StageMap => ({ location: s, dates: s, travel: s, stay: s, food_activities: s });

describe("inferStages", () => {
  it("a new trip has everything open", () => {
    expect(inferStages(trip())).toEqual(all("open"));
  });

  it("a trip voting on destinations has location in progress", () => {
    expect(inferStages(trip({ status: "voting" })).location).toBe("in_progress");
  });

  it("a locked trip with dates has location and dates decided", () => {
    const s = inferStages(trip({ status: "locked", destination_name: "Asheville", start_date: "2026-11-12", end_date: "2026-11-16" }));
    expect(s).toMatchObject({ location: "decided", dates: "decided", travel: "open" });
  });

  it("dates on an unlocked trip aren't decided by inference", () => {
    expect(inferStages(trip({ start_date: "2026-11-12", end_date: "2026-11-16" })).dates).toBe("open");
  });

  it("a booked stay is decided", () => {
    expect(inferStages(trip({ stay: { name: "Cabin", kind: "rental" } })).stay).toBe("decided");
  });
});

describe("stagesOf", () => {
  it("stored values win over inference; missing ones are inferred", () => {
    const s = stagesOf(trip({ status: "locked", destination_name: "Boone", stages: { dates: "in_progress", travel: "decided" } }));
    expect(s).toEqual({ location: "decided", dates: "in_progress", travel: "decided", stay: "open", food_activities: "open" });
  });

  it("ignores junk in the stored map", () => {
    const s = stagesOf(trip({ stages: { location: "maybe" as never } }));
    expect(s.location).toBe("open");
  });
});

describe("nextStage", () => {
  it("is the earliest stage that isn't decided", () => {
    expect(nextStage(all("open"))).toBe("location");
    expect(nextStage({ ...all("decided"), travel: "in_progress", stay: "open" })).toBe("travel");
  });

  it("info out of order doesn't skip an earlier stage", () => {
    // Dates were decided before anyone picked a place: location is still next.
    expect(nextStage({ ...all("open"), dates: "decided" })).toBe("location");
  });

  it("is null when everything is decided", () => {
    expect(nextStage(all("decided"))).toBeNull();
  });
});

describe("cascadeReopen", () => {
  it("reopening location resets every later stage", () => {
    const { map, reset } = cascadeReopen(all("decided"), "location");
    expect(map).toEqual({ location: "in_progress", dates: "open", travel: "open", stay: "open", food_activities: "open" });
    expect(reset).toEqual(["dates", "travel", "stay", "food_activities"]);
  });

  it("reopening dates resets travel, stay and food but keeps location", () => {
    const { map, reset } = cascadeReopen(all("decided"), "dates");
    expect(map).toEqual({ location: "decided", dates: "in_progress", travel: "open", stay: "open", food_activities: "open" });
    expect(reset).toEqual(["travel", "stay", "food_activities"]);
  });

  it("reopening travel touches nothing else", () => {
    const { map, reset } = cascadeReopen(all("decided"), "travel");
    expect(map).toEqual({ ...all("decided"), travel: "in_progress" });
    expect(reset).toEqual([]);
  });

  it("only reports stages that actually changed", () => {
    const { reset } = cascadeReopen({ ...all("open"), location: "decided", dates: "decided" }, "location");
    expect(reset).toEqual(["dates"]);
  });

  it("doesn't mutate its input", () => {
    const before = all("decided");
    cascadeReopen(before, "location");
    expect(before).toEqual(all("decided"));
  });
});

describe("what the agent and the page see", () => {
  it("describes stages in order with their state", () => {
    expect(describeStages({ ...all("open"), location: "decided", dates: "in_progress" })).toBe("location ✓ · dates (in progress) · travel · stay · food & activities");
  });

  it("names the next thing to settle and the tool for it", () => {
    const lines = stageLines({ ...all("open"), location: "decided" }, { destination_name: "Boone", start_date: null, end_date: null });
    expect(lines.join("\n")).toContain("where: Boone");
    expect(lines.join("\n")).toContain("next thing to settle: dates");
    expect(lines.join("\n")).toContain("find_dates");
  });

  it("flags dates kept from before the place changed", () => {
    const lines = stageLines({ ...all("open"), location: "in_progress" }, { destination_name: null, start_date: "2026-11-12", end_date: "2026-11-16" });
    expect(lines.join("\n")).toMatch(/not confirmed/);
  });

  it("the trip page gets a stage bar with what was decided", () => {
    const bar = stagesFor({ ...trip({ status: "locked", destination_name: "Boone", start_date: "2026-11-12", end_date: "2026-11-15" }) } as TripRow);
    expect(bar.map((s) => s.key)).toEqual(["location", "dates", "travel", "stay", "food_activities"]);
    expect(bar[0]).toEqual({ key: "location", label: "Location", status: "decided", detail: "Boone" });
    expect(bar[1]!.detail).toBe("Nov 12 – Nov 15");
    expect(bar[2]).toEqual({ key: "travel", label: "Travel", status: "open" });
  });
});
