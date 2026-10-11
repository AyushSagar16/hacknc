// The public trip page's data. A copy of src/site/types.ts in the Atlas bot, which owns the
// shape and publishes it to Supabase — change both together.
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
