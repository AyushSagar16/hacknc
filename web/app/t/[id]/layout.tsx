import { notFound } from "next/navigation";
import { SectionNav } from "@/components/SectionNav";
import { getTrip } from "@/lib/data";
import { formatRange, tripFacts } from "@/lib/format";
import { coverPhoto } from "@/lib/images";

export default async function TripLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = await getTrip(id);
  if (!trip) notFound();
  const cover = await coverPhoto(trip);
  const when = formatRange(trip.startDate, trip.endDate);
  const place = trip.destination && trip.destination !== trip.title ? trip.destination : "";
  return (
    <>
      <header className="hero">
        {/* Wikimedia serves the sized thumbnail. */}
        {cover ? <img src={cover.src} alt={cover.alt} fetchPriority="high" /> : null}
        <div className="caption">
          <h1>{trip.title}</h1>
          <p className="facts">{[place, when, tripFacts(trip)].filter(Boolean).join(" · ")}</p>
        </div>
      </header>
      <SectionNav tripId={trip.id} />
      {children}
      <p className="credit">
        Photos from <a href="https://commons.wikimedia.org" rel="noopener noreferrer" target="_blank">Wikimedia Commons</a>
      </p>
    </>
  );
}
