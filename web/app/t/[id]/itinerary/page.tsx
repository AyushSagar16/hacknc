import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTrip } from "@/lib/data";
import { weekday } from "@/lib/format";
import { dayPhotos } from "@/lib/images";
import { previewFor, toMetadata } from "@/lib/meta";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const trip = await getTrip(id);
  return trip ? toMetadata(previewFor("itinerary", trip), `/t/${trip.id}/itinerary`) : { title: "Not found" };
}

const SETTING: Record<string, string> = { outdoor: "outdoors", indoor: "indoors", either: "" };

export default async function Itinerary({ params }: Props) {
  const { id } = await params;
  const trip = await getTrip(id);
  if (!trip) notFound();
  if (!trip.itinerary.length)
    return <p className="glass panel muted">No itinerary yet. It shows up here once the group locks a destination and dates.</p>;
  const photos = await dayPhotos(trip.itinerary, trip.destination ?? trip.title);
  return (
    <>
      {trip.itinerary.map((d, i) => {
        const photo = photos[i];
        return (
          <section key={d.date} className={`day glass${photo ? " has-photo" : ""}`}>
            {photo ? (
              <div className="thumb">
                <img src={photo.src} alt={photo.alt} loading="lazy" />
              </div>
            ) : null}
            <div className="body">
              <p className="day-label">
                Day {i + 1} · {weekday(d.date)}
              </p>
              {d.title ? <h3>{d.title}</h3> : null}
              {d.items.length ? (
                <ul>
                  {d.items.map((item) => {
                    const facts = [SETTING[item.setting], item.cost].filter(Boolean);
                    return (
                      <li key={item.name}>
                        {item.time ? <span className="time">{item.time}</span> : null}
                        {item.name}
                        {facts.length ? <span className="muted small"> · {facts.join(" · ")}</span> : null}
                        {item.notes ? <div className="muted small">{item.notes}</div> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted">Free day.</p>
              )}
              {d.note ? <p className="muted small note">{d.note}</p> : null}
            </div>
          </section>
        );
      })}
    </>
  );
}
