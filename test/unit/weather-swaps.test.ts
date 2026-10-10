// Swap proposals: day swap vs replacement, ranking, interests, cost limit, and when to stay quiet.
import { describe, expect, it } from "vitest";
import type { Change, ChangeKind, DaySnapshot } from "../../src/weather/diff.ts";
import { proposeSwap, type ItineraryDay, type SpareActivity, type SwapInput } from "../../src/weather/swaps.ts";

const THU = "2026-10-15";
const FRI = "2026-10-16";
const SAT = "2026-10-17";
const SUN = "2026-10-18";
const MON = "2026-10-19";

const snap = (day: string, over: Partial<DaySnapshot> = {}): DaySnapshot => ({
  day,
  category: "clear",
  precipProbability: 5,
  tempMaxF: 78,
  windGustMph: 12,
  ...over,
});

const rainySat = snap(SAT, { category: "rain", precipProbability: 70 });

function change(kind: ChangeKind = "turned_wet", to: DaySnapshot = rainySat, summary = "saturday flipped to rain (70%)"): Change {
  return { day: to.day, kind, from: snap(to.day), to, severity: kind === "storm" ? 3 : 2, summary };
}

const itinerary: ItineraryDay[] = [
  { date: FRI, items: [{ activityId: "market", name: "Food Market Tour", setting: "indoor", costCents: 4000, tags: ["food"] }] },
  {
    date: SAT,
    items: [
      { activityId: "dinner", name: "Dinner at Husk", setting: "indoor", costCents: 6000 },
      { activityId: "beach", name: "Beach Day", setting: "outdoor", costCents: 1000, tags: ["beach"] },
    ],
  },
  { date: SUN, items: [{ activityId: "kayak", name: "Kayak Tour", setting: "outdoor", costCents: 5500 }] },
];

const spares: SpareActivity[] = [
  { id: "aquarium", name: "South Carolina Aquarium", setting: "indoor", costCents: 3500, tags: ["animals", "kids"] },
  { id: "gibbes", name: "Gibbes Museum", setting: "indoor", costCents: 1500, tags: ["art", "history"] },
  { id: "cooking", name: "Lowcountry Cooking Class", setting: "indoor", costCents: 9000, tags: ["food"] },
  { id: "plantation", name: "Plantation Garden Walk", setting: "outdoor", costCents: 2000, tags: ["history"] },
];

function input(over: Partial<SwapInput> = {}): SwapInput {
  return {
    change: change(),
    itinerary,
    spareActivities: spares,
    interests: { food: 0.9, art: 0.5, history: 0.4, animals: 0.3 },
    forecastByDay: new Map([
      [FRI, snap(FRI)],
      [SAT, rainySat],
      [SUN, snap(SUN, { category: "cloudy" })],
    ]),
    ...over,
  };
}

describe("proposeSwap: swap days", () => {
  it("swaps the outdoor plan with an indoor one on a dry day", () => {
    expect(proposeSwap(input())).toEqual({
      day: SAT,
      kind: "swap_days",
      outdoor: { activityId: "beach", name: "Beach Day", costCents: 1000 },
      replacement: { activityId: "market", name: "Food Market Tour", costCents: 4000, fromDay: FRI },
      message: "saturday flipped to rain (70%). want to swap the beach day for the food market tour on friday?",
      pollOptions: ["swap them", "keep the plan"],
    });
  });

  it("prefers the nearest dry day", () => {
    const days: ItineraryDay[] = [
      { date: THU, items: [{ activityId: "museum", name: "Museum", setting: "indoor", costCents: 0 }] },
      ...itinerary.slice(1),
      { date: SUN, items: [{ activityId: "tea", name: "Tea Room", setting: "indoor", costCents: 0 }] },
    ];
    const forecastByDay = new Map([
      [THU, snap(THU)],
      [SAT, rainySat],
      [SUN, snap(SUN, { category: "cloudy" })],
    ]);
    const p = proposeSwap(input({ itinerary: days, forecastByDay }));
    expect(p?.replacement).toMatchObject({ activityId: "tea", fromDay: SUN });
  });

  it("breaks distance ties by indoor over either, then clearer skies, then the earlier day", () => {
    const days = (fri: ItineraryDay["items"][number], sun: ItineraryDay["items"][number]): ItineraryDay[] => [
      { date: FRI, items: [fri] },
      itinerary[1]!,
      { date: SUN, items: [sun] },
    ];
    const either = { activityId: "either", name: "Walking Food Tour", setting: "either" as const, costCents: 0 };
    const indoor = { activityId: "indoor", name: "Escape Room", setting: "indoor" as const, costCents: 0 };
    const indoor2 = { activityId: "indoor2", name: "Bowling", setting: "indoor" as const, costCents: 0 };

    expect(proposeSwap(input({ itinerary: days(either, indoor) }))?.replacement.activityId).toBe("indoor");

    const cloudyFri = new Map([
      [FRI, snap(FRI, { category: "cloudy" })],
      [SAT, rainySat],
      [SUN, snap(SUN)],
    ]);
    expect(proposeSwap(input({ itinerary: days(indoor, indoor2), forecastByDay: cloudyFri }))?.replacement.activityId).toBe(
      "indoor2",
    );

    const bothClear = new Map([
      [FRI, snap(FRI)],
      [SAT, rainySat],
      [SUN, snap(SUN)],
    ]);
    expect(proposeSwap(input({ itinerary: days(indoor, indoor2), forecastByDay: bothClear }))?.replacement.activityId).toBe(
      "indoor",
    );
  });

  it("accepts an either-setting item when no indoor one exists", () => {
    const days: ItineraryDay[] = [
      { date: FRI, items: [{ activityId: "walk", name: "Walking Food Tour", setting: "either", costCents: 0 }] },
      itinerary[1]!,
    ];
    expect(proposeSwap(input({ itinerary: days }))?.replacement.activityId).toBe("walk");
  });

  it("skips dry days that are windy, unforecast, or already past", () => {
    const windy = new Map([
      [FRI, snap(FRI, { windGustMph: 45 })],
      [SAT, rainySat],
    ]);
    expect(proposeSwap(input({ forecastByDay: windy }))?.kind).toBe("replace");

    const unforecast = new Map([[SAT, rainySat]]);
    expect(proposeSwap(input({ forecastByDay: unforecast }))?.kind).toBe("replace");

    expect(proposeSwap(input({ today: SAT }))?.kind).toBe("replace");
  });

  it("never swaps onto another wet day", () => {
    const wet = new Map([
      [FRI, snap(FRI, { category: "storm", precipProbability: 80 })],
      [SAT, rainySat],
    ]);
    expect(proposeSwap(input({ forecastByDay: wet }))?.kind).toBe("replace");
  });
});

describe("proposeSwap: replace", () => {
  const noSwap = { forecastByDay: new Map([[SAT, rainySat]]) };

  it("replaces with the best-liked spare indoor activity within budget", () => {
    // cooking (food 0.9) is over budget: 9000 > 1000 + 2500; gibbes scores 0.9 vs aquarium 0.3.
    expect(proposeSwap(input(noSwap))).toEqual({
      day: SAT,
      kind: "replace",
      outdoor: { activityId: "beach", name: "Beach Day", costCents: 1000 },
      replacement: { activityId: "gibbes", name: "Gibbes Museum", costCents: 1500 },
      message: "saturday flipped to rain (70%). want to swap the beach day for the gibbes museum instead? it's $5 more",
      pollOptions: ["swap it", "keep the plan"],
    });
  });

  it("follows the group's interests", () => {
    const p = proposeSwap(input({ ...noSwap, interests: { animals: 1, art: 0.1 } }));
    expect(p?.replacement.activityId).toBe("aquarium");
    expect(p?.message).toContain("it's $25 more");
  });

  it("lets a higher budget unlock pricier options", () => {
    const p = proposeSwap(input({ ...noSwap, interests: { food: 1, art: 0.2 }, maxExtraCostCents: 10_000 }));
    expect(p?.replacement.activityId).toBe("cooking");
    expect(p?.message).toContain("it's $80 more");
  });

  it("enforces the cost limit at exactly $25 more by default", () => {
    const exact = [{ id: "x", name: "Exact", setting: "indoor" as const, costCents: 3500, tags: [] }];
    const over = [{ id: "y", name: "Over", setting: "indoor" as const, costCents: 3501, tags: [] }];
    expect(proposeSwap(input({ ...noSwap, spareActivities: exact }))?.replacement.activityId).toBe("x");
    expect(proposeSwap(input({ ...noSwap, spareActivities: over }))).toBeNull();
  });

  it("mentions savings and stays quiet about equal cost", () => {
    const kayakRain = snap(SUN, { category: "rain", precipProbability: 80 });
    const sunChange = change("turned_wet", kayakRain, "sunday flipped to rain (80%)");
    const forecastByDay = new Map([[SUN, kayakRain]]);
    const cheaper = [{ id: "c", name: "Cheaper", setting: "indoor" as const, costCents: 3000, tags: [] }];
    expect(proposeSwap(input({ change: sunChange, forecastByDay, spareActivities: cheaper }))?.message).toBe(
      "sunday flipped to rain (80%). want to swap the kayak tour for the cheaper instead? it saves $25",
    );
    const same = [{ id: "s", name: "The Battery Stroll", setting: "either" as const, costCents: 5500, tags: [] }];
    expect(proposeSwap(input({ change: sunChange, forecastByDay, spareActivities: same }))?.message).toBe(
      "sunday flipped to rain (80%). want to swap the kayak tour for the battery stroll instead?",
    );
  });

  it("prefers indoor over either, then cheaper, on equal interest", () => {
    const tie: SpareActivity[] = [
      { id: "either", name: "A", setting: "either", costCents: 0, tags: ["art"] },
      { id: "pricey", name: "B", setting: "indoor", costCents: 2000, tags: ["art"] },
      { id: "cheap", name: "C", setting: "indoor", costCents: 1000, tags: ["art"] },
    ];
    expect(proposeSwap(input({ ...noSwap, spareActivities: tie }))?.replacement.activityId).toBe("cheap");
  });

  it("skips outdoor spares and anything already on the itinerary", () => {
    const only: SpareActivity[] = [
      { id: "plantation", name: "Plantation Garden Walk", setting: "outdoor", costCents: 0, tags: ["food"] },
      { id: "market", name: "Food Market Tour", setting: "indoor", costCents: 0, tags: ["food"] },
    ];
    expect(proposeSwap(input({ ...noSwap, spareActivities: only }))).toBeNull();
  });
});

describe("proposeSwap: when to stay quiet", () => {
  it("returns null when the day has nothing outdoor", () => {
    const friRain = snap(FRI, { category: "rain", precipProbability: 80 });
    expect(proposeSwap(input({ change: change("turned_wet", friRain, "friday flipped to rain (80%)") }))).toBeNull();
  });

  it("returns null for a day not on the itinerary", () => {
    const monRain = snap(MON, { category: "rain", precipProbability: 80 });
    expect(proposeSwap(input({ change: change("turned_wet", monRain) }))).toBeNull();
  });

  it("returns null for cleared_up", () => {
    const clear = snap(SAT);
    expect(proposeSwap(input({ change: { ...change("cleared_up", clear), severity: 1 } }))).toBeNull();
  });

  it("only acts on a temp swing that leaves the comfort band", () => {
    const warm = snap(SAT, { tempMaxF: 91 });
    expect(proposeSwap(input({ change: change("temp_swing", warm, "saturday jumped to 91° (was 78°)") }))).toBeNull();
    const cold = snap(SAT, { tempMaxF: 46 });
    const p = proposeSwap(input({ change: change("temp_swing", cold, "saturday dropped to 46° (was 70°)") }));
    expect(p?.message).toBe("saturday dropped to 46° (was 70°). want to swap the beach day for the food market tour on friday?");
  });

  it("acts on storms and wind", () => {
    const storm = snap(SAT, { category: "storm", precipProbability: 85 });
    expect(proposeSwap(input({ change: change("storm", storm, "saturday flipped to thunderstorms (85%)") }))?.kind).toBe(
      "swap_days",
    );
    const windy = snap(SAT, { windGustMph: 48 });
    expect(proposeSwap(input({ change: change("wind", windy, "saturday gusts up to 48 mph") }))?.message).toBe(
      "saturday gusts up to 48 mph. want to swap the beach day for the food market tour on friday?",
    );
  });

  it("returns null when there is neither a dry day nor an affordable spare", () => {
    expect(proposeSwap(input({ forecastByDay: new Map([[SAT, rainySat]]), spareActivities: [] }))).toBeNull();
  });
});
