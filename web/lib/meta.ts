// What each section looks like as an iMessage link preview. iMessage reads og:title,
// og:description, og:site_name and og:image from the page; the image comes from each route's
// opengraph-image.tsx. Every section gets its own title and description so a link to the
// itinerary doesn't preview like a link to the overview.
import type { Metadata } from "next";
import { clip, formatRange, itineraryLine, tripFacts } from "./format";
import type { SiteSection, SiteTrip } from "./types";

export interface Preview {
  /** Small line above the title on the OG image ("itinerary"). */
  eyebrow: string;
  title: string;
  /** Second line on the OG image. */
  subtitle: string;
  /** og:description. */
  description: string;
}

const placeOf = (t: SiteTrip) => t.destination ?? t.title;

export function previewFor(section: SiteSection, trip: SiteTrip): Preview {
  const when = formatRange(trip.startDate, trip.endDate);
  const place = placeOf(trip);
  const facts = tripFacts(trip);
  switch (section) {
    case "overview":
      return {
        eyebrow: "trip",
        title: trip.title,
        subtitle: [trip.destination && trip.destination !== trip.title ? trip.destination : "", when, facts].filter(Boolean).join(" · "),
        description: clip(
          trip.summary ??
            (sentences([trip.overview.stage, trip.overview.decision, trip.travelers.length ? `With ${listNames(trip.travelers)}` : undefined]) ||
              "The whole plan in one place."),
          180,
        ),
      };
    case "itinerary":
      return {
        eyebrow: "itinerary",
        title: place,
        subtitle: [when, trip.itinerary.length ? `${trip.itinerary.length} days planned` : "not planned yet"].filter(Boolean).join(" · "),
        description: trip.itinerary.length ? itineraryLine(trip.itinerary) : "The day-by-day plan shows up here once the group picks where to stay and what to eat and do.",
      };
  }
}

export function toMetadata(p: Preview, path: string): Metadata {
  const title = p.eyebrow === "trip" ? p.title : `${p.title} ${p.eyebrow}`;
  return {
    title,
    description: p.description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: "Atlas", title, description: p.description, url: path },
    twitter: { card: "summary_large_image", title, description: p.description },
  };
}

/** Join phrases as sentences without doubling their periods. */
function sentences(parts: (string | undefined)[]): string {
  return parts
    .filter((p): p is string => Boolean(p && p.trim()))
    .map((p) => p.trim().replace(/\.+$/, ""))
    .join(". ")
    .concat(parts.some(Boolean) ? "." : "");
}

function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length <= 4) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} others`;
}
