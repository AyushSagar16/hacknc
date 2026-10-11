import type { Metadata } from "next";
import { getMessages, getTrip } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { previewFor, toMetadata } from "@/lib/meta";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const trip = await getTrip(id);
  if (!trip) return { title: "Not found" };
  return toMetadata(previewFor("chat", trip, { messages: await getMessages(trip.id) }), `/t/${trip.id}/chat`);
}

// Times are shown in the group chat's own timezone.
const time = (iso: string, timeZone: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
const dayOf = (iso: string, timeZone: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone });

export default async function Chat({ params }: Props) {
  const { id } = await params;
  const trip = (await getTrip(id))!;
  const messages = await getMessages(trip.id);
  if (!messages.length) return <p className="muted">No messages yet.</p>;
  let lastDay = "";
  return (
    <ul className="chat">
      {messages.map((m) => {
        const d = dayOf(m.sentAt, trip.timezone);
        const header = d !== lastDay ? <div className="chat-day">{formatDate(d, { weekday: "long", month: "long", day: "numeric" })}</div> : null;
        lastDay = d;
        return (
          <li key={m.localId} className={m.fromAtlas ? "atlas" : undefined}>
            {header}
            <span className="who">{m.sender}</span>
            <span className="time">{time(m.sentAt, trip.timezone)}</span>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
          </li>
        );
      })}
    </ul>
  );
}
