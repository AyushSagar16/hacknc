import { describe, expect, it } from "vitest";
import { stayLabel, webQueryFor, type GroupPrefs } from "../../src/agent/features/places.ts";

const prefs = (p: Partial<GroupPrefs> = {}): GroupPrefs => ({ dietary: new Map(), interests: {}, cuisines: {}, lowMobility: false, ...p });

describe("stayLabel", () => {
  it("keeps a hotel's name", () => expect(stayLabel("Aloft Asheville Downtown")).toBe("aloft asheville downtown"));
  it("drops a listing's pitch", () => expect(stayLabel("Cozy efficiency with kitchenette. Pet friendly")).toBe("your stay"));
});

describe("webQueryFor", () => {
  it("looks up what they asked for", () => expect(webQueryFor("food", "orlando", prefs(), "indian food")).toBe("indian food in orlando"));
  it("leans on favourite cuisines and diets", () =>
    expect(webQueryFor("food", "orlando", prefs({ cuisines: { indian: 2, bbq: -1 }, dietary: new Map([["vegetarian", ["maya"]]]) }))).toBe("best vegetarian indian restaurants in orlando"));
  it("things to do lean on interests", () => expect(webQueryFor("activity", "orlando", prefs({ interests: { theme_parks: 2 } }))).toBe("things to do in orlando for people who like theme parks"));
});
