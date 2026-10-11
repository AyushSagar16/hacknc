// The 👍 when Atlas reads a message it isn't answering, one trip-page link per reply, cuisine
// preferences (extraction value, profile, group weights), the food question, the searches behind
// a shortlist, and keeping the group's picks when Atlas rewrites a day of the plan.
import { describe, expect, it } from "vitest";
import restaurants from "../fixtures/serpapi/google_maps_asheville_restaurants.json" with { type: "json" };
import { acknowledge, MAX_ACKS_PER_TURN } from "../../src/agent/brain.ts";
import { addressedReason } from "../../src/agent/addressed.ts";
import { oneSiteLink } from "../../src/agent/links.ts";
import { cuisineSummary, cuisineWeights, foodAnswered, foodAskText, foodKnown } from "../../src/agent/features/places.ts";
import { keepPicks } from "../../src/agent/features/site.ts";
import { aggregate } from "../../src/profile/aggregate.ts";
import { groupView } from "../../src/profile/groupView.ts";
import { toFactValue, type Fact } from "../../src/profile/schema.ts";
import { cuisineFit, parseMapsResults, queriesFor, rankPlaces } from "../../src/trips/nearby.ts";
import type { MessageRow } from "../../src/db/repos/core.ts";
import type { Action } from "../../src/transport/outbound.ts";

let id = 0;
const inbound = (person: number, text: string) => ({ id: ++id, person_id: person, provider_message_id: `p${id}`, text, kind: "text", direction: "inbound" }) as const;

describe("👍 acknowledgements", () => {
  it("likes the latest message per person when the turn says nothing", () => {
    const a = inbound(1, "nov 12-16 works for me");
    const b = inbound(1, "from raleigh");
    const c = inbound(2, "i'm in charlotte");
    const actions: Action[] = [];
    acknowledge(actions, [a, b, c]);
    expect(actions).toEqual([
      { type: "react", targetId: b.provider_message_id, tapback: "like" },
      { type: "react", targetId: c.provider_message_id, tapback: "like" },
    ]);
  });

  it("stays out of it when Atlas already said something, and skips small talk and repeats", () => {
    const said: Action[] = [{ type: "say", text: "nice, that works" }];
    acknowledge(said, [inbound(1, "thai for sure")]);
    expect(said).toHaveLength(1);
    const m = inbound(2, "sushi please");
    const voted: Action[] = [{ type: "react", targetId: m.provider_message_id, tapback: "like" }];
    acknowledge(voted, [m, inbound(3, "lol ok")]);
    expect(voted).toHaveLength(1);
  });

  it("caps the likes in one turn", () => {
    const actions: Action[] = [];
    acknowledge(actions, [1, 2, 3, 4, 5, 6].map((p) => inbound(p, "i can do the 14th")));
    expect(actions).toHaveLength(MAX_ACKS_PER_TURN);
  });

  it("an Atlas tapback doesn't close its open question for the next person", () => {
    const base = new Date("2026-10-10T18:00:00Z").getTime();
    const row = (over: Partial<MessageRow>, s: number): MessageRow =>
      ({ id: ++id, chat_id: 1, person_id: 1, provider_message_id: `p${id}`, direction: "inbound", kind: "text", text: "", reply_to_provider_id: null, meta: {}, sent_at: new Date(base + s * 1000), received_at: new Date(base), turn_id: null, speakable: true, extracted_at: null, ...over }) as MessageRow;
    const ask = row({ direction: "outbound", person_id: null, text: "what kind of food is everyone into?" }, 0);
    const first = row({ person_id: 1, text: "indian" }, 10);
    const like = row({ direction: "outbound", person_id: null, kind: "reaction", text: "(like tapback)" }, 11);
    const second = row({ person_id: 2, text: "tacos" }, 20);
    expect(addressedReason({ message: second, history: [ask, first, like, second], agentName: "Atlas", namesById: new Map([[1, "maya"], [2, "leo"]]) })).toBe("answers_question");
  });
});

describe("one trip-page link per reply", () => {
  const BASE = "https://trips.test";
  const page = `${BASE}/t/abc?v=3`;

  it("keeps the last link to the site and drops the URL the model typed", () => {
    const out = oneSiteLink(
      [
        { type: "say", text: `here's the plan: ${BASE}/t/abc and all your trips ${BASE}/g/xyz` },
        { type: "link", url: `${BASE}/t/abc/itinerary?v=2`, fallbackText: "full itinerary" },
        { type: "link", url: page, fallbackText: "trip page" },
      ],
      BASE,
    );
    expect(out).toEqual([
      { type: "say", text: "here's the plan: and all your trips" },
      { type: "link", url: page, fallbackText: "trip page" },
    ]);
  });

  it("with no link action, only the first typed link stays", () => {
    const out = oneSiteLink([{ type: "say", text: `trip page: ${page}\nall trips: ${BASE}/g/xyz` }], BASE);
    expect(out).toEqual([{ type: "say", text: `trip page: ${page}\nall trips:` }]);
  });

  it("leaves bank-connect links, other sites and replies without links alone", () => {
    const actions: Action[] = [
      { type: "link", url: `${BASE}/connect/tok.sig`, fallbackText: "connect your capital one" },
      { type: "say", text: "stays: https://example.com/charleston/rental/1" },
      { type: "link", url: page },
    ];
    expect(oneSiteLink(actions, BASE)).toEqual(actions);
    expect(oneSiteLink(actions, undefined)).toEqual(actions);
  });

  it("drops a bubble that was only the link", () => {
    expect(oneSiteLink([{ type: "say", text: page }, { type: "link", url: page }], BASE)).toEqual([{ type: "link", url: page }]);
  });
});

let factId = 1;
const fact = (personId: number, name: string, polarity: Fact["polarity"] = "positive", minutes = 0): Fact => ({
  id: factId++,
  personId,
  key: "cuisine",
  value: { name },
  polarity,
  explicit: true,
  confidence: 0.9,
  visibility: "public",
  sourceMessageId: null,
  quote: name,
  observedAt: new Date(Date.parse("2026-10-10T15:00:00Z") + minutes * 60_000),
  retracted: false,
});

describe("cuisine preferences", () => {
  it("extraction's flat field becomes a lowercase cuisine", () => {
    expect(toFactValue("cuisine", { cuisine: "Thai" })).toEqual({ name: "thai" });
    expect(toFactValue("cuisine", { cuisine: "x" })).toBeUndefined();
  });

  it("resolves likes and dislikes per cuisine; a later neutral clears it", () => {
    const p = aggregate(1, [fact(1, "thai"), fact(1, "seafood", "negative"), fact(1, "bbq", "positive", 0), fact(1, "bbq", "neutral", 5)]);
    expect(p.cuisines?.map((c) => c.value)).toEqual(["thai"]);
    expect(p.cuisineDislikes?.map((c) => c.value)).toEqual(["seafood"]);
  });

  it("the group view weighs them and knows who has answered", () => {
    const members = [
      { personId: 1, label: "Maya", profile: aggregate(1, [fact(1, "indian"), fact(1, "thai")]) },
      { personId: 2, label: "Leo", profile: aggregate(2, [fact(2, "thai"), fact(2, "seafood", "negative")]) },
      { personId: 3, label: "Priya", profile: aggregate(3, []) },
    ];
    const view = groupView(members, "2026-10-10");
    expect(cuisineWeights(view)).toEqual({ indian: 1, thai: 2, seafood: -1 });
    expect([...foodAnswered(view)]).toEqual([1, 2]);
    expect(foodKnown(view)).toBe(true);
    expect(foodKnown(groupView(members.slice(0, 1).concat(members[2]!), "2026-10-10"))).toBe(false);
    expect(cuisineSummary(view)).toBe("maya: indian, thai · leo: thai");
  });

  it("the food question names who's left only once someone has answered", () => {
    expect(foodAskText("Aloft Asheville Downtown", [])).toBe("🍽️ aloft asheville downtown is locked in, so now food and things to do.\nwhat kind of food is everyone into for this trip? cuisines, a spot you've heard of, anything you're craving?");
    expect(foodAskText(undefined, ["priya"])).toMatch(/\npriya, what kind of food/);
  });
});

describe("shortlist searches", () => {
  it("adds the group's favourite cuisines or interests to the general search", () => {
    expect(queriesFor("food", { dietary: ["vegetarian"], cuisines: { thai: 2, indian: 1, sushi: 1, seafood: -1, anything: 3 } })).toEqual(["vegetarian friendly restaurants", "thai restaurants", "indian restaurants"]);
    expect(queriesFor("activity", { interests: { music: 2, hiking: 1, food: 3 } })).toEqual(["things to do", "live music venues", "hiking trails"]);
    expect(queriesFor("food", { query: "tacos", cuisines: { thai: 1 } })).toEqual(["tacos restaurants"]);
  });

  it("matches cuisines by the words places use", () => {
    expect(cuisineFit({ name: "Buxton Hall Barbecue", types: [], category: "Barbecue restaurant" }, { bbq: 2 })).toBe(2);
    expect(cuisineFit({ name: "Gan Shan Station", types: ["Asian fusion restaurant"] }, { sushi: 1, seafood: -1 })).toBe(0);
    expect(cuisineFit({ name: "Oyster House", types: ["Seafood restaurant"] }, { seafood: -1 })).toBe(-1);
  });

  it("gives every cuisine someone asked for a slot when there's a place for it", () => {
    const places = parseMapsResults(restaurants, "food");
    const plain = rankPlaces(places, { dietary: ["vegetarian"], limit: 5 }).map((p) => p.name);
    expect(plain).not.toContain("Mamacita's Taqueria");
    const asked = rankPlaces(places, { dietary: ["vegetarian"], cuisines: { tacos: 1, indian: 1 }, limit: 5 }).map((p) => p.name);
    expect(asked).toContain("Mamacita's Taqueria");
    expect(asked[0]).toBe("Chai Pani");
    expect(asked).toHaveLength(5);
  });
});

describe("rewriting a day keeps the picks", () => {
  it("puts back a picked place the new day left out, and leaves other days as they are", () => {
    const pick = { activityId: "place:food:chai", name: "Chai Pani", setting: "indoor" as const, costCents: 0, time: "dinner" };
    const before = [{ date: "2026-11-12", items: [pick] }, { date: "2026-11-13", items: [] }];
    const after = [{ date: "2026-11-12", items: [{ activityId: "custom:biltmore", name: "Biltmore Estate", setting: "either" as const, costCents: 0 }] }, { date: "2026-11-13", items: [] }];
    const kept = keepPicks(before, after, new Set(["2026-11-12"]), [{ name: "Chai Pani", day: "2026-11-12" }]);
    expect(kept[0]!.items.map((i) => i.name)).toEqual(["Biltmore Estate", "Chai Pani"]);
    // Already there (by name): not doubled.
    const named = [{ date: "2026-11-12", items: [{ ...pick, activityId: "custom:dinner-at-chai-pani", name: "Dinner at Chai Pani" }] }];
    expect(keepPicks(before, named, new Set(["2026-11-12"]), [{ name: "Chai Pani", day: "2026-11-12" }])[0]!.items).toHaveLength(1);
  });
});
