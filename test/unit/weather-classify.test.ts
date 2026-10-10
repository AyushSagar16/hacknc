// WMO code classification, the low-probability downgrade, and chat phrases.
import { readFileSync } from "node:fs";
import { describe as group, expect, it } from "vitest";
import { classify, describe, isDry, isWet } from "../../src/weather/classify.ts";

group("classify", () => {
  it.each([
    [0, "clear"],
    [1, "clear"],
    [2, "cloudy"],
    [3, "cloudy"],
    [45, "cloudy"],
    [48, "cloudy"],
    [51, "rain"],
    [55, "rain"],
    [57, "rain"],
    [61, "rain"],
    [65, "rain"],
    [67, "rain"],
    [80, "rain"],
    [82, "rain"],
    [71, "snow"],
    [77, "snow"],
    [85, "snow"],
    [86, "snow"],
    [95, "storm"],
    [96, "storm"],
    [99, "storm"],
  ] as const)("code %i -> %s", (code, expected) => {
    expect(classify(code, 80)).toBe(expected);
  });

  it("treats codes outside the WMO daily set as cloudy", () => {
    for (const code of [4, 10, 50, 58, 70, 83, 90, -1, 100]) expect(classify(code, 80)).toBe("cloudy");
  });

  it("downgrades low-probability rain to cloudy", () => {
    expect(classify(61, 34)).toBe("cloudy");
    expect(classify(61, 35)).toBe("rain");
    expect(classify(51, 9)).toBe("cloudy");
  });

  it("applies the same downgrade to storms and snow", () => {
    expect(classify(95, 20)).toBe("cloudy");
    expect(classify(95, 35)).toBe("storm");
    expect(classify(73, 10)).toBe("cloudy");
  });

  it("trusts the code when probability is unknown", () => {
    expect(classify(63, null)).toBe("rain");
    expect(classify(95, null)).toBe("storm");
  });

  it("never upgrades a dry code because of probability", () => {
    expect(classify(0, 90)).toBe("clear");
    expect(classify(3, 90)).toBe("cloudy");
  });

  it("classifies the captured Charleston forecast sensibly", () => {
    const body = JSON.parse(readFileSync(new URL("../fixtures/open-meteo/forecast-charleston.json", import.meta.url), "utf8")) as {
      daily: { weather_code: number[]; precipitation_probability_max: number[] };
    };
    const cats = body.daily.weather_code.map((c, i) => classify(c, body.daily.precipitation_probability_max[i] ?? null));
    expect(cats[0]).toBe("rain"); // 82 @ 92%
    expect(cats[1]).toBe("rain"); // 65 @ 45%
    expect(cats[7]).toBe("cloudy"); // drizzle 51 @ 9%
    expect(cats[3]).toBe("clear");
  });
});

group("isWet / isDry", () => {
  it("splits the five categories", () => {
    expect((["clear", "cloudy", "rain", "storm", "snow"] as const).map(isWet)).toEqual([false, false, true, true, true]);
    expect((["clear", "cloudy", "rain", "storm", "snow"] as const).map(isDry)).toEqual([true, true, false, false, false]);
  });
});

group("describe", () => {
  it("gives short lowercase phrases", () => {
    expect(describe("clear", 78.4)).toBe("sunny, 78°");
    expect(describe("cloudy", 63.6)).toBe("cloudy, 64°");
    expect(describe("rain", 70)).toBe("rain");
    expect(describe("storm", 88)).toBe("thunderstorms");
    expect(describe("snow", 28)).toBe("snow");
  });

  it("omits the temperature when unknown", () => {
    expect(describe("clear", null)).toBe("sunny");
    expect(describe("cloudy", Number.NaN)).toBe("cloudy");
  });
});
