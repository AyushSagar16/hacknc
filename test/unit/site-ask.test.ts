import { describe, expect, it } from "vitest";
import { asksForTripPage, looksLikeItinerary } from "../../src/agent/siteAsk.ts";

const ask = (t: string) => asksForTripPage(t, { agentName: "Atlas", memberNames: ["maya", "leo", "priya"] });

describe("asksForTripPage", () => {
  it.each([
    "what's the itinerary",
    "So what's the iteniery",
    "Iteneiery",
    "itinerary?",
    "whats the itenerary",
    "what is the itinery",
    "where's the intinerary",
    "atlas show us the plan",
    "Show us the plan",
    "Show us the website renters",
    "show me the website",
    "send the link",
    "send us the link pls",
    "where's the trip page",
    "wheres the trip site",
    "can i see the itinerary",
    "can we get the itinerary",
    "link to the itinerary",
    "is there an itinerary yet",
    "do we have an itinerary",
    "any itinerary yet?",
    "the plan?",
    "what's the plan",
    "ok the website",
    "trip page",
    "show us the day by day itinerary",
    "atlas send the page",
    "what's the itinerary for the trip",
    "Alright tell me the plan",
    "tell me the itinerary",
    "tell us the plan",
    "what does the plan look like",
    "walk me through the plan",
    "recap the itinerary",
    "how's the itinerary looking",
    "yeah send the itinerary",
  ])("matches %j", (t) => expect(ask(t)).toBe(true));

  it.each([
    "we should plan",
    "plan b?",
    "what should we plan",
    "i have a plan",
    "what's the plan for dinner",
    "send the link to the airbnb",
    "send the link to leo",
    "leo what's the plan",
    "maya, show me the itinerary",
    "we need to make an itinerary",
    "link",
    "page",
    "lets plan the trip",
    "the plan is to leave at 9",
    "i'll make the itinerary tonight",
    "what's the interview process",
    "inventory",
    "can you plan something for friday",
    "tell me the plan for dinner",
    "how do we plan this",
    "",
  ])("ignores %j", (t) => expect(ask(t)).toBe(false));

  it("recognizes itinerary misspellings only", () => {
    for (const w of ["itinerary", "iteniery", "itenerary", "itinery", "iteneiery", "intinerary", "itineray", "itin"]) expect(looksLikeItinerary(w)).toBe(true);
    for (const w of ["interview", "inventory", "internet", "itself", "iteration", "plan", "intern"]) expect(looksLikeItinerary(w)).toBe(false);
  });
});
