import type { Metadata } from "next";
import Link from "next/link";
import { StageBar } from "@/components/StageBar";
import { TripFund } from "@/components/TripFund";
import { getChatTrips, getMessages, getResearch, getTrip } from "@/lib/data";
import { formatRange, itineraryLine } from "@/lib/format";
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
  const trip = (await getTrip(id))!;
  const [research, messages, siblings] = await Promise.all([getResearch(trip.id), getMessages(trip.id, 3), getChatTrips(trip.chatId)]);
  const { overview } = trip;
  const others = siblings.filter((t) => t.id !== trip.id);

  return (
    <>
      {overview.stages?.length ? <StageBar stages={overview.stages} /> : null}
      {trip.summary ? <p>{trip.summary}</p> : overview.stage ? <p>{overview.stage}</p> : null}
      {trip.travelers.length ? <p className="muted">Travelers: {trip.travelers.join(", ")}</p> : null}

      {overview.fund ? <TripFund fund={overview.fund} /> : null}

      {overview.options.length ? (
        <>
          <h2>Options</h2>
          <ol>
            {overview.options.map((o) => (
              <li key={o.name}>
                <strong>{o.name}</strong> — about {o.perPerson} per person
                {o.votes !== undefined ? <span className="muted"> · {o.votes} vote{o.votes === 1 ? "" : "s"}</span> : null}
                {o.why ? <div className="muted small">{o.why}</div> : null}
              </li>
            ))}
          </ol>
          {overview.decision ? <p>{overview.decision}</p> : null}
        </>
      ) : null}

      <h2>
        <Link href={`/t/${trip.id}/itinerary`}>Itinerary</Link>
      </h2>
      <p className="muted">{trip.itinerary.length ? itineraryLine(trip.itinerary, 220) : "Not planned yet."}</p>

      <h2>
        <Link href={`/t/${trip.id}/research`}>Research</Link>
      </h2>
      {research.length ? (
        <ul>
          {research.map((r) => (
            <li key={r.topic}>
              <strong>{r.topic}</strong> <span className="muted">— {r.summary}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing researched yet.</p>
      )}

      <h2>
        <Link href={`/t/${trip.id}/chat`}>Chat</Link>
      </h2>
      {messages.length ? (
        <ul className="chat">
          {messages.map((m) => (
            <li key={m.localId} className={m.fromAtlas ? "atlas" : undefined}>
              <span className="who">{m.sender}:</span> {m.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No messages yet.</p>
      )}

      {overview.booking.length ? (
        <>
          <h2>Booking</h2>
          <ul>
            {overview.booking.map((b) => (
              <li key={b.url}>
                <a href={b.url} rel="noopener noreferrer nofollow" target="_blank">
                  {b.label}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {others.length ? (
        <>
          <hr />
          <p className="small muted">Other trips in this chat:</p>
          <ul className="small">
            {others.map((t) => (
              <li key={t.id}>
                <Link href={`/t/${t.id}`}>{t.title}</Link>
                {t.startDate ? <span className="muted"> · {formatRange(t.startDate, t.endDate)}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
