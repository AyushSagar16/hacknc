import type { Metadata } from "next";
import { getResearch, getTrip } from "@/lib/data";
import { Markdown } from "@/lib/markdown";
import { previewFor, toMetadata } from "@/lib/meta";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const trip = await getTrip(id);
  if (!trip) return { title: "Not found" };
  return toMetadata(previewFor("research", trip, { research: await getResearch(trip.id) }), `/t/${trip.id}/research`);
}

export default async function Research({ params }: Props) {
  const { id } = await params;
  const trip = (await getTrip(id))!;
  const notes = await getResearch(trip.id);
  if (!notes.length) return <p className="muted">Nothing researched yet. Ask Atlas in the chat to look into visas, weather, neighborhoods or food.</p>;
  return (
    <>
      {notes.map((n) => (
        <section key={n.topic}>
          <h2>{n.topic}</h2>
          <p>
            <em>{n.summary}</em>
          </p>
          <Markdown source={n.bodyMd} />
          {n.sources.length ? (
            <p className="sources">
              Sources:{" "}
              {n.sources.map((s, i) => (
                <span key={s.url}>
                  {i ? ", " : ""}
                  <a href={s.url} rel="noopener noreferrer nofollow" target="_blank">
                    {s.title}
                  </a>
                </span>
              ))}
            </p>
          ) : null}
        </section>
      ))}
    </>
  );
}
