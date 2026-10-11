import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StageBar } from "@/components/StageBar";
import { TripFund } from "@/components/TripFund";
import { getChatTrips, getResearch, getTrip } from "@/lib/data";
import { formatRange, itineraryLine } from "@/lib/format";
import { placesPhoto } from "@/lib/images";
import { previewFor, toMetadata } from "@/lib/meta";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const trip = await getTrip(id);
  return trip ? toMetadata(previewFor("overview", trip), `/t/${trip.id}`) : { title: "Not found" };
}

export default async function Overview({ params }: Props) {
  const { id } = await params;
  const trip = await getTrip(id);
  if (!trip) notFound();
  const { overview } = trip;
  const [research, siblings, optionPhotos] = await Promise.all([
    getResearch(trip.id),
    getChatTrips(trip.chatId),
    Promise.all(overview.options.map((o) => placesPhoto(o.name, 640))),
  ]);
  const others = siblings.filter((t) => t.id !== trip.id);
  const lead = Math.max(0, ...overview.options.map((o) => o.votes ?? 0));
  const decided = Boolean(overview.decision) || ["locked", "ongoing", "settling", "done"].includes(trip.status);

  return (
    <>
      {overview.stages?.length ? <StageBar stages={overview.stages} /> : null}
      {trip.summary || overview.stage ? <p className="lede">{trip.summary ?? overview.stage}</p> : null}
      {trip.travelers.length ? <p className="muted small">With {trip.travelers.join(", ")}</p> : null}

      {overview.fund ? <TripFund fund={overview.fund} /> : null}

      {overview.options.length ? (
        <section className="glass panel">
          <h2>Options</h2>
          <ul className="options">
            {overview.options.map((o, i) => {
              const photo = optionPhotos[i];
              const won = decided && lead > 0 && o.votes === lead;
              return (
                <li key={o.name} className={`option glass${won ? " won" : ""}`}>
                  <div className="thumb">
                    {/* Wikimedia serves the sized thumbnail. */}
                    {photo ? <img src={photo.src} alt={photo.alt} loading="lazy" /> : null}
                  </div>
                  <div className="body">
                    <strong>{o.name}</strong>
                    <span className="muted small">about {o.perPerson} per person</span>
                    {o.why ? <div className="muted small">{o.why}</div> : null}
                    {o.votes !== undefined ? (
                      <div style={{ marginTop: 8 }}>
                        <span className={`pill${won ? " chosen" : ""}`}>
                          {won ? "Chosen · " : ""}
                          {o.votes} vote{o.votes === 1 ? "" : "s"}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {overview.decision ? <p className="muted small">{overview.decision}</p> : null}
        </section>
      ) : null}

      <section className="glass panel">
        <h2>
          <Link href={`/t/${trip.id}/itinerary`}>Itinerary</Link>
        </h2>
        <p className="muted">{trip.itinerary.length ? itineraryLine(trip.itinerary, 220) : "Not planned yet."}</p>
      </section>

      <section className="glass panel">
        <h2>
          <Link href={`/t/${trip.id}/research`}>Research</Link>
        </h2>
        {research.length ? (
          <ul className="list-plain">
            {research.map((r) => (
              <li key={r.topic}>
                <strong>{r.topic}</strong> <span className="muted">· {r.summary}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing researched yet.</p>
        )}
      </section>

      {overview.booking.length ? (
        <section className="glass panel">
          <h2>Book</h2>
          <div className="buttons">
            {overview.booking.map((b) => (
              <a key={b.url} className="button" href={b.url} rel="noopener noreferrer nofollow" target="_blank">
                {b.label}
              </a>
            ))}
          </div>
        </section>
      ) : null}

      {others.length ? (
        <section className="glass panel">
          <h2>Other trips in this chat</h2>
          <ul className="list-plain">
            {others.map((t) => (
              <li key={t.id}>
                <Link href={`/t/${t.id}`}>{t.title}</Link>
                {t.startDate ? <span className="muted"> · {formatRange(t.startDate, t.endDate)}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
