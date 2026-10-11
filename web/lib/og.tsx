// The preview image iMessage shows above a link: the trip's cover photo under a soft sky shade,
// like the site's header. A wide image is what gets iMessage's large card instead of the small
// title-only one.
import { ImageResponse } from "next/og";
import { getResearch, getTrip } from "./data";
import { clip } from "./format";
import { coverPhoto, type Photo } from "./images";
import { previewFor, type Preview } from "./meta";
import type { SiteSection } from "./types";

export const ogSize = { width: 1200, height: 630 };
export const ogContentType = "image/png";

export async function sectionImage(id: string, section: SiteSection): Promise<ImageResponse> {
  const trip = await getTrip(id);
  if (!trip) return render({ eyebrow: "atlas", title: "Atlas", subtitle: "trip planning in your group chat", description: "" });
  const extra = section === "research" ? { research: await getResearch(trip.id) } : {};
  return render(previewFor(section, trip, extra), await coverPhoto(trip));
}

function render(p: Preview, photo: Photo | null = null): ImageResponse {
  const titleSize = p.title.length > 22 ? 84 : p.title.length > 14 ? 104 : 128;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          background: "linear-gradient(160deg, #8fd3f4 0%, #3aa0d8 50%, #1a6fa3 100%)",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        {photo ? <img src={photo.src} alt="" width={1200} height={630} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "cover" }} /> : null}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            padding: "64px 80px",
            backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(5,25,40,0.05) 35%, rgba(5,25,40,0.72) 100%)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: titleSize, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 }}>{clip(p.title, 40)}</div>
            {p.subtitle ? <div style={{ display: "flex", marginTop: 24, fontSize: 40, color: "rgba(255,255,255,0.9)" }}>{clip(p.subtitle, 60)}</div> : null}
          </div>
        </div>
      </div>
    ),
    ogSize,
  );
}
