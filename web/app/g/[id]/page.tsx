import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getChatTrips } from "@/lib/data";
import { formatRange, statusLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const trips = await getChatTrips((await params).id);
  if (!trips.length) return { title: "Not found" };
  const description = trips.map((t) => t.title).join(", ");
  return { title: "Trips", description, openGraph: { siteName: "Atlas", title: "Our trips", description } };
}

export default async function ChatTrips({ params }: Props) {
  const trips = await getChatTrips((await params).id);
  if (!trips.length) notFound();
  return (
    <>
      <h1>Trips</h1>
      <p className="facts">Every trip planned in this group chat.</p>
      <ul className="glass panel list-plain">
        {trips.map((t) => (
          <li key={t.id}>
            <Link href={`/t/${t.id}`}>{t.title}</Link>
            <span className="muted"> · {[formatRange(t.startDate, t.endDate), statusLabel(t.status)].filter(Boolean).join(" · ")}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
