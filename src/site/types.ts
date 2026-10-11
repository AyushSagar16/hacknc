// The public trip page's data, as Atlas publishes it to Supabase. Atlas owns this shape;
// web/lib/types.ts is a copy for the site — change both together.
// Public means public: first names only, no handles, no budgets or balances.

export type SiteSection = "overview" | "itinerary" | "research" | "chat";

export interface SiteOption {
  name: string;
  /** Per-person estimate, already formatted ("$640"). */
  perPerson: string;
  why?: string;
  votes?: number;
}

export interface SiteOverview {
  /** One line on where the trip stands ("voting on 3 options", "locked in"). */
  stage: string;
  options: SiteOption[];
  /** "egypt won 3 of 4" once a poll decided. */
  decision?: string;
  booking: { label: string; url: string }[];
  /**
   * Where each part of the plan stands, in order (location, dates, travel, stay, food &
   * activities). Optional: pages published before stages existed don't have it.
   */
  stages?: SiteStage[];
  fund?: SiteFund;
  /** The booked stay, once there is one. */
  stay?: SiteStay;
}

export interface SiteStay {
  name: string;
  kind: "hotel" | "rental";
  checkIn: string;
  checkOut: string;
  totalCents: number;
  link: string | null;
  rating: number | null;
}

export interface SiteFund {
  /** e.g. "Capital One · Tahoe Trip Fund" */
  accountLabel: string;
  targetCents: number;
  collectedCents: number;
  /** ISO date (YYYY-MM-DD) contributions are due by, if set */
  deadline: string | null;
  /** first names only; never budgets */
  members: { name: string; shareCents: number; contributedCents: number; nextCents: number | null; nextDate: string | null }[];
  /** newest first */
  transactions: { at: string; kind: "contribution" | "purchase" | "refund" | "transfer"; label: string; amountCents: number }[];
}

export interface SiteStage {
  key: "location" | "dates" | "travel" | "stay" | "food_activities";
  /** "Location", "Dates", "Travel", "Stay", "Food & activities". */
  label: string;
  status: "open" | "in_progress" | "decided";
  /** What was decided, when it was ("Boone, NC", "Nov 12–16"). */
  detail?: string;
}

export interface SiteDay {
  date: string;
  title?: string;
  items: { name: string; setting: "outdoor" | "indoor" | "either"; cost?: string; time?: string; notes?: string }[];
  /** e.g. "swapped for rain". */
  note?: string;
}

export interface SiteTrip {
  id: string;
  chatId: string;
  title: string;
  /** Atlas's own few sentences on where the plan stands. */
  summary: string | null;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string;
  travelers: string[];
  /** The chat's IANA timezone, for message times. */
  timezone: string;
  overview: SiteOverview;
  itinerary: SiteDay[];
  version: number;
}

export interface SiteResearch {
  topic: string;
  summary: string;
  bodyMd: string;
  sources: { title: string; url: string }[];
  createdAt: string;
}

export interface SiteMessage {
  localId: number;
  sender: string;
  fromAtlas: boolean;
  text: string;
  sentAt: string;
}
