// The preview image iMessage shows above a link: text only, black on white, like the site.
// A wide image is what gets iMessage's large card instead of the small title-only one.
import { ImageResponse } from "next/og";
import { getMessages, getResearch, getTrip } from "./data";
import { clip } from "./format";
import { previewFor, type Preview } from "./meta";
import type { SiteSection } from "./types";

export const ogSize = { width: 1200, height: 630 };
export const ogContentType = "image/png";

export async function sectionImage(id: string, section: SiteSection): Promise<ImageResponse> {
  const trip = await getTrip(id);
  if (!trip) return render({ eyebrow: "atlas", title: "Atlas", subtitle: "trip planning in your group chat", description: "" });
  const extra =
    section === "research" ? { research: await getResearch(trip.id) } : section === "chat" ? { messages: await getMessages(trip.id) } : {};
  return render(previewFor(section, trip, extra));
}

function render(p: Preview): ImageResponse {
  const titleSize = p.title.length > 22 ? 84 : p.title.length > 14 ? 104 : 128;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "#ffffff",
          color: "#111111",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 34, letterSpacing: 2, textTransform: "uppercase", color: "#6b6b6b" }}>{p.eyebrow}</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: titleSize, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 }}>{clip(p.title, 40)}</div>
          {p.subtitle ? <div style={{ display: "flex", marginTop: 28, fontSize: 42, color: "#333333" }}>{clip(p.subtitle, 60)}</div> : null}
        </div>
        <div style={{ display: "flex", fontSize: 30, color: "#6b6b6b" }}>atlas</div>
      </div>
    ),
    ogSize,
  );
}
