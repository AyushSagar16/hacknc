import React from "react";
import { Img, staticFile } from "remotion";
import { ios } from "../theme";

// Destination photos, from each place's Wikimedia Commons page image (credits in video/README.md),
// the same source the trip pages use (web/lib/images.ts).
export type Place = "charleston" | "savannah" | "wilmington";

export const SITE = "planwithatlas.tech";

export const PlacePhoto: React.FC<{
  place: Place;
  height: number | string;
  style?: React.CSSProperties;
}> = ({ place, height, style }) => (
  <Img
    src={staticFile(`images/${place}.jpg`)}
    style={{
      display: "block",
      width: "100%",
      height,
      objectFit: "cover",
      ...style,
    }}
  />
);

// The rich link preview iMessage shows for a trip page: the photo with the place's name large in
// white over it, then a grey band with the page title and the domain.
export const LinkPreview: React.FC<{
  place: Place;
  name: string;
  caption: string;
  title: string;
  // Width of the card in px; type scales with it.
  width: number;
  photoHeight: number;
  // Text is sized for a phone-width card; scale it up when the card is shown on the canvas.
  textScale?: number;
  // Extra content at the right of the grey band (e.g. a vote count).
  aside?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({
  place,
  name,
  caption,
  title,
  width,
  photoHeight,
  textScale = 1,
  aside,
  style,
}) => {
  const u = width / 100;
  const t = u * textScale;
  return (
    <div
      style={{
        width,
        borderRadius: u * 5.4,
        overflow: "hidden",
        background: "#e5e5ea",
        fontFamily: ios,
        color: "#000",
        ...style,
      }}
    >
      <div style={{ position: "relative", height: photoHeight }}>
        <PlacePhoto place={place} height="100%" />
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, rgba(0,0,0,0) 35%, rgba(0,0,0,0.5) 100%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: u * 6,
            right: u * 6,
            bottom: u * 4.6,
            color: "#fff",
            textShadow: "0 1px 10px rgba(0,0,0,0.35)",
          }}
        >
          <div
            style={{
              fontSize: t * 10.5,
              fontWeight: 400,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
            }}
          >
            {name}
          </div>
          <div style={{ fontSize: t * 3.9, marginTop: u * 1.6, opacity: 0.95 }}>
            {caption}
          </div>
        </div>
      </div>
      <div
        style={{
          padding: `${u * 3.4}px ${u * 4.4}px ${u * 3.8}px`,
          display: "flex",
          alignItems: "center",
          gap: u * 3,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: t * 4.6,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              lineHeight: 1.25,
            }}
          >
            {title}
          </div>
          <div
            style={{ fontSize: t * 4, color: "#6e6e73", marginTop: u * 0.6 }}
          >
            {SITE}
          </div>
        </div>
        {aside}
      </div>
    </div>
  );
};
