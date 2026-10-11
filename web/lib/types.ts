// The public trip page's data. Mirrors src/site/types.ts in the Atlas bot, which owns the shape
// and publishes it to Supabase — change both together. The site reads only what it shows: the
// published chat log and research sources aren't read here.
// Public means public: first names only, no handles, no budgets or balances.

export type SiteSection = "overview" | "itinerary" | "research";

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
  /** The chat's IANA timezone. */
  timezone: string;
  overview: SiteOverview;
  itinerary: SiteDay[];
  version: number;
}

export interface SiteResearch {
  topic: string;
  summary: string;
  bodyMd: string;
  createdAt: string;
}
