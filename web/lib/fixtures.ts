// Dev-only sample data so the trip page can be previewed without Supabase:
//   ATLAS_SITE_FIXTURES=1 npm run dev  →  http://localhost:3000/t/00000000-0000-4000-8000-00000000a71a
// Never used in production builds (see lib/data.ts). Mirrors what scripts/site-seed.ts publishes.
import type { SiteResearch, SiteTrip } from "./types";

export const FIXTURE_CHAT_ID = "00000000-0000-4000-8000-0000000c4a75";
export const FIXTURE_TRIP_ID = "00000000-0000-4000-8000-00000000a71a";
export const FIXTURE_EARLY_TRIP_ID = "00000000-0000-4000-8000-00000000b0de";

const tahoe: SiteTrip = {
  id: FIXTURE_TRIP_ID,
  chatId: FIXTURE_CHAT_ID,
  title: "Tahoe",
  summary: "South Lake Tahoe is locked in for Jan 15–18. Everyone's travel is sorted; the cabin's booked and the fund is filling up on paydays.",
  destination: "South Lake Tahoe, CA",
  startDate: "2027-01-15",
  endDate: "2027-01-18",
  status: "locked",
  travelers: ["Maya", "Leo", "Priya", "Sam"],
  timezone: "America/Los_Angeles",
  overview: {
    stage: "Locked in: South Lake Tahoe.",
    options: [],
    decision: "South Lake Tahoe won the vote (3 of 4).",
    booking: [{ label: "the cabin", url: "https://www.google.com/travel/hotels/South%20Lake%20Tahoe" }],
    stages: [
      { key: "location", label: "Location", status: "decided", detail: "South Lake Tahoe" },
      { key: "dates", label: "Dates", status: "decided", detail: "Jan 15–18" },
      { key: "travel", label: "Travel", status: "decided", detail: "2 drive · 2 fly" },
      { key: "stay", label: "Stay", status: "decided", detail: "Heavenly Pines Cabin" },
      { key: "food_activities", label: "Food & activities", status: "in_progress" },
    ],
    fund: {
      accountLabel: "Capital One · Tahoe Trip Fund",
      targetCents: 120_000,
      collectedCents: 84_000,
      deadline: "2027-01-01",
      members: [
        { name: "Maya", shareCents: 30_000, contributedCents: 30_000, nextCents: null, nextDate: null },
        { name: "Leo", shareCents: 30_000, contributedCents: 21_000, nextCents: 9_000, nextDate: "2026-12-18" },
        { name: "Priya", shareCents: 30_000, contributedCents: 18_000, nextCents: 6_000, nextDate: "2026-12-15" },
        { name: "Sam", shareCents: 30_000, contributedCents: 15_000, nextCents: 7_500, nextDate: "2026-12-19" },
      ],
      transactions: [
        { at: "2026-12-04T17:00:00Z", kind: "contribution", label: "Leo", amountCents: 9_000 },
        { at: "2026-12-01T17:00:00Z", kind: "contribution", label: "Priya", amountCents: 6_000 },
        { at: "2026-11-28T21:10:00Z", kind: "purchase", label: "Heavenly Pines Cabin deposit", amountCents: 40_000 },
        { at: "2026-11-21T17:00:00Z", kind: "contribution", label: "Sam", amountCents: 7_500 },
        { at: "2026-11-20T17:00:00Z", kind: "contribution", label: "Maya", amountCents: 30_000 },
        { at: "2026-11-15T17:00:00Z", kind: "contribution", label: "Priya", amountCents: 12_000 },
      ],
    },
  },
  itinerary: [
    { date: "2027-01-15", title: "Arrive", items: [{ name: "Check in at Heavenly Pines Cabin", setting: "indoor", time: "4pm" }] },
    { date: "2027-01-16", title: "Ski day", items: [{ name: "Heavenly Mountain Resort", setting: "outdoor", cost: "~$190 pp", time: "9am" }] },
    { date: "2027-01-17", title: "Lake day", items: [{ name: "Emerald Bay snowshoe", setting: "outdoor", time: "10am" }] },
    { date: "2027-01-18", items: [] },
  ],
  version: 4,
};

const early: SiteTrip = {
  id: FIXTURE_EARLY_TRIP_ID,
  chatId: FIXTURE_CHAT_ID,
  title: "Spring break",
  summary: null,
  destination: null,
  startDate: null,
  endDate: null,
  status: "planning",
  travelers: tahoe.travelers,
  timezone: tahoe.timezone,
  overview: {
    stage: "Still gathering everyone's dates and home cities.",
    options: [],
    booking: [],
    stages: [
      { key: "location", label: "Location", status: "in_progress" },
      { key: "dates", label: "Dates", status: "open" },
      { key: "travel", label: "Travel", status: "open" },
      { key: "stay", label: "Stay", status: "open" },
      { key: "food_activities", label: "Food & activities", status: "open" },
    ],
  },
  itinerary: [],
  version: 1,
};

export const FIXTURE_TRIPS: SiteTrip[] = [tahoe, early];

export const FIXTURE_RESEARCH: SiteResearch[] = [
  {
    topic: "Chains & driving",
    summary: "Carry chains or have AWD; US-50 over Echo Summit can close in storms.",
    bodyMd: "Caltrans posts chain controls on US-50 and I-80. Check before leaving.",
    createdAt: "2026-11-20T18:00:00Z",
  },
];
