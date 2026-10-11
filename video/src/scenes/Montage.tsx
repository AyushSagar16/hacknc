import React from "react";
import { AbsoluteFill } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { GlassCard } from "../components/Glass";
import { Headline } from "../components/Text";
import { C, ios } from "../theme";

// Everything else it does, quickly.
const CARDS: { icon: string; title: string; quote: string }[] = [
  {
    icon: "🌧️",
    title: "Watches the forecast",
    quote:
      "saturday flipped to rain. want to swap the beach day for the food tour?",
  },
  {
    icon: "🧠",
    title: "Remembers weeks later",
    quote: "leo said he's vegetarian, and the food tour is veg friendly",
  },
  {
    icon: "🔒",
    title: "Private by default",
    quote: "budgets stay private, so here's just the pooled number",
  },
  {
    icon: "🤫",
    title: "Knows when to be quiet",
    quote: "stays out of banter. “atlas stay quiet” mutes it",
  },
];

export const Montage: React.FC = () => (
  <AbsoluteFill>
    <Backdrop seed="montage" bubbles={6} />
    <Headline
      at={0}
      size={92}
      align="center"
      text={"And it *keeps watch.*"}
      style={{ position: "absolute", top: 96, width: "100%" }}
    />
    <div
      style={{
        position: "absolute",
        top: 290,
        left: 130,
        right: 130,
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 30,
      }}
    >
      {CARDS.map((c, i) => (
        <GlassCard
          key={c.title}
          at={8 + i * 7}
          from="scale"
          style={{
            padding: "34px 36px",
            display: "flex",
            gap: 26,
            alignItems: "flex-start",
          }}
        >
          <div
            style={{
              width: 92,
              height: 92,
              borderRadius: 26,
              flexShrink: 0,
              display: "grid",
              placeItems: "center",
              fontSize: 50,
              background:
                "radial-gradient(circle at 35% 25%, #ffffff, #d8eef9 60%, #b5dcf1)",
              boxShadow:
                "inset 0 -6px 14px rgba(92,196,244,0.3), 0 8px 20px rgba(14,60,90,0.1)",
            }}
          >
            {c.icon}
          </div>
          <div>
            <div
              style={{
                fontSize: 44,
                fontWeight: 800,
                letterSpacing: "-0.02em",
              }}
            >
              {c.title}
            </div>
            <div
              style={{
                marginTop: 16,
                display: "inline-block",
                background: C.gray,
                borderRadius: 22,
                padding: "12px 20px",
                fontFamily: ios,
                fontSize: 27,
                lineHeight: 1.3,
                color: "#000",
              }}
            >
              {c.quote}
            </div>
          </div>
        </GlassCard>
      ))}
    </div>
  </AbsoluteFill>
);
