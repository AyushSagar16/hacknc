import { notFound } from "next/navigation";
import { SectionNav } from "@/components/SectionNav";
import { getTrip } from "@/lib/data";
import { formatRange, tripFacts } from "@/lib/format";

export default async function TripLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = await getTrip(id);
  if (!trip) notFound();
  const when = formatRange(trip.startDate, trip.endDate);
  const place = trip.destination && trip.destination !== trip.title ? trip.destination : "";
  return (
    <>
      <h1>{trip.title}</h1>
      <p className="facts">{[place, when, tripFacts(trip)].filter(Boolean).join(" · ")}</p>
      <SectionNav tripId={trip.id} />
      {children}
    </>
  );
}
