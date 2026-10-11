import type { Metadata } from "next";
import { getTrip } from "@/lib/data";
import { weekday } from "@/lib/format";
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
  const trip = (await getTrip(id))!;
  if (!trip.itinerary.length) return <p className="muted">No itinerary yet. It shows up here once the group locks a destination and dates.</p>;
  return (
    <>
      {trip.itinerary.map((d, i) => (
        <section key={d.date} className="day">
          <h3>
            Day {i + 1}
            {d.title ? `: ${d.title}` : ""} <span className="muted">· {weekday(d.date)}</span>
          </h3>
          {d.items.length ? (
            <ul>
              {d.items.map((item) => (
                <li key={item.name}>
                  {item.time ? <span className="muted">{item.time} · </span> : null}
                  {item.name}
                  {[SETTING[item.setting], item.cost].filter(Boolean).length ? (
                    <span className="muted small"> · {[SETTING[item.setting], item.cost].filter(Boolean).join(" · ")}</span>
                  ) : null}
                  {item.notes ? <div className="muted small">{item.notes}</div> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Free day.</p>
          )}
          {d.note ? <p className="muted small note">{d.note}</p> : null}
        </section>
      ))}
    </>
  );
}
