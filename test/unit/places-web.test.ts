import { describe, expect, it } from "vitest";
import { pickIntent, stayLabel, webQueryFor, type GroupPrefs } from "../../src/agent/features/places.ts";
import type { TripPlaceRow } from "../../src/trips/placesStore.ts";

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

describe("pickIntent", () => {
  const row = (idx: number, name: string, status = "suggested") => ({ id: idx, idx, name, status, kind: "activity" }) as unknown as TripPlaceRow;
  const rows = [row(1, "Chai Pani"), row(6, "Disney World park day"), row(7, "Universal Orlando / Epic Universe day"), row(8, "ICON Park"), row(9, "Pike Place Market"), row(10, "Lakeside Park Cafe")];
  const names = (t: string) => pickIntent(t, rows)?.rows.map((r) => r.name);
  it("picks a place someone says they'll go to, from a partial name", () => {
    expect(names("I'll go to universal find me the tickets to that")).toEqual(["Universal Orlando / Epic Universe day"]);
    expect(pickIntent("I'll go to universal find me the tickets to that", rows)?.wantsInfo).toBe(true);
    expect(pickIntent("let's do disney", rows)?.wantsInfo).toBe(false);
  });
  it("reads other intent phrasings", () => {
    expect(names("let's do disney")).toEqual(["Disney World park day"]);
    expect(names("add icon park")).toEqual(["ICON Park"]);
    expect(names("we'll do chai pani and disney")).toEqual(["Chai Pani", "Disney World park day"]);
    expect(names("find me tickets for universal?")).toEqual(["Universal Orlando / Epic Universe day"]);
  });
  it("ignores opinions, refusals and questions", () => {
    expect(names("universal is too expensive")).toBeUndefined();
    expect(names("no disney")).toBeUndefined();
    expect(names("what about universal?")).toBeUndefined();
    expect(names("i don't want to do disney")).toBeUndefined();
  });
  it("does not match on generic words or ambiguous ones", () => {
    expect(names("let's do a park day")).toBeUndefined();
    expect(names("let's go to the market")).toBeUndefined();
    expect(names("let's do dinner")).toBeUndefined();
  });
  it("skips places already picked", () => expect(pickIntent("let's do disney", [row(6, "Disney World park day", "picked")])).toBeNull());
});
