import { describe, expect, it } from "vitest";
import { noteFromLookup } from "../../src/agent/features/research.ts";
import { matchTrip } from "../../src/agent/features/trips.ts";
import { firstName } from "../../src/site/snapshot.ts";
import { pageUrl } from "../../src/site/publish.ts";
import type { TripRow } from "../../src/trips/state.ts";

const trip = (id: number, title: string | null, destination: string | null) => ({ id, title, destination_name: destination }) as TripRow;

describe("research notes", () => {
  it("turns a verified list into bullets with its source", () => {
    const note = noteFromLookup("Things to do", {
      kind: "list",
      heading: "things to do in asheville in march",
      items: [
        { name: "biltmore estate", detail: "house tours and gardens" },
        { name: "craggy gardens", detail: "short hike, big views" },
        { name: "river arts district" },
      ],
      source: "https://www.exploreasheville.com/things-to-do",
    });
    expect(note).toEqual({
      topic: "Things to do",
      summary: "Top picks: biltmore estate, craggy gardens, river arts district.",
      bodyMd: "- **Biltmore estate**: house tours and gardens\n- **Craggy gardens**: short hike, big views\n- **River arts district**",
      sources: [{ title: "exploreasheville.com", url: "https://www.exploreasheville.com/things-to-do" }],
    });
  });

  it("keeps a short fact as a note and skips date lookups", () => {
    expect(noteFromLookup("do we need a car", { kind: "facts", answer: "most sights are walkable downtown. a car helps for the parkway." })?.summary).toBe("Most sights are walkable downtown.");
    expect(noteFromLookup("winter break", { kind: "dates", start: "2026-12-12", end: "2027-01-05", confidence: "high", note: "" })).toBeNull();
    expect(noteFromLookup("food", { kind: "list", heading: "food", items: [] })).toBeNull();
  });
});

describe("trips", () => {
  const trips = [trip(1, null, "Asheville"), trip(2, "japan", null), trip(3, "spring break", "Miami")];

  it("matches a trip by title, destination, partial name or ordinal", () => {
    expect(matchTrip(trips, "asheville")?.id).toBe(1);
    expect(matchTrip(trips, "Japan")?.id).toBe(2);
    expect(matchTrip(trips, "the spring break one")?.id).toBe(3);
    expect(matchTrip(trips, "miami")?.id).toBe(3);
    expect(matchTrip(trips, "the second one")?.id).toBe(2);
    expect(matchTrip(trips, "trip 1")?.id).toBe(1);
    expect(matchTrip(trips, "paris")).toBeUndefined();
    expect(matchTrip(trips, "")).toBeUndefined();
  });
});

describe("trip page links", () => {
  it("deep-links sections and busts iMessage's preview cache with the version", () => {
    expect(pageUrl("https://x.test", "abc", "overview", 4)).toBe("https://x.test/t/abc?v=4");
    expect(pageUrl("https://x.test", "abc", "itinerary", 5)).toBe("https://x.test/t/abc/itinerary?v=5");
    expect(pageUrl("https://x.test", "abc", "chat")).toBe("https://x.test/t/abc/chat");
  });

  it("shows people by first name only, never a handle", () => {
    expect(firstName("maya chen")).toBe("Maya");
    expect(firstName("…0142")).toBe("someone");
  });
});

describe("agent-written itinerary", async () => {
  const { itineraryInput, mergeItinerary, summaryInput } = await import("../../src/site/content.ts");
  const { findDestination } = await import("../../src/trips/catalog.ts");
  const dest = findDestination("asheville")!;
  const trip = { start: "2027-03-05", end: "2027-03-07", dest };

  it("replaces only the days it's given and keeps every trip day", () => {
    const first = mergeItinerary([], itineraryInput.parse({ days: [{ date: "2027-03-06", items: [{ name: "Biltmore Estate", setting: "either", time: "10am" }] }] }), trip);
    expect(first.map((d) => [d.date, d.items.length])).toEqual([["2027-03-05", 0], ["2027-03-06", 1], ["2027-03-07", 0]]);
    const known = first[1]!.items[0]!;
    expect(known.activityId).not.toMatch(/^custom:/);
    expect(known.costCents).toBeGreaterThan(0);
    expect(known.time).toBe("10am");

    const second = mergeItinerary(first, itineraryInput.parse({ days: [{ date: "2027-03-05", title: "arrive", items: [{ name: "Tacos at White Duck", setting: "indoor" }] }] }), trip);
    expect(second[0]!.items[0]).toMatchObject({ activityId: "custom:tacos-at-white-duck", costCents: 0 });
    expect(second[1]).toEqual(first[1]);
  });

  it("refuses dates outside the trip and money from the model", () => {
    expect(() => mergeItinerary([], itineraryInput.parse({ days: [{ date: "2027-03-09", items: [] }] }), trip)).toThrow(/outside the trip/);
    expect(itineraryInput.safeParse({ days: [{ date: "2027-03-05", items: [{ name: "Spa", setting: "indoor", notes: "about 120 dollars" }] }] }).success).toBe(false);
    expect(summaryInput.safeParse({ summary: "Locked in, about $600 each." }).success).toBe(false);
    expect(summaryInput.safeParse({ summary: "Locked in for March 5–7. Next: flights." }).success).toBe(true);
  });
});
