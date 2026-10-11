import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { ChapterOut, Chip, GlassCard } from "../../components/Glass";
import { Eyebrow, Headline } from "../../components/Text";
import { C, clamp } from "../../theme";
import { Area } from "./Area";

// Preferences and limits pulled out of normal texting, each with the words it came from.
const PEOPLE: {
  name: string;
  at: number;
  quote: string;
  chips: [string, "accent" | "veto" | "plain"][];
}[] = [
  {
    name: "Maya",
    at: 60,
    quote: "“i want a beach”",
    chips: [
      ["🏖️ Beach", "accent"],
      ["📅 Nov 12–16", "plain"],
      ["📍 Raleigh", "plain"],
    ],
  },
  {
    name: "Leo",
    at: 112,
    quote: "“cancun is too pricey for me”",
    chips: [
      ["✕ Cancún", "veto"],
      ["🥦 Vegetarian", "accent"],
      ["📍 Durham", "plain"],
    ],
  },
  {
    name: "Priya",
    at: 164,
    quote: "“i can only do driving distance”",
    chips: [
      ["🚗 Drive only", "veto"],
      ["🍜 Food first", "accent"],
      ["📅 Nov 12–16", "plain"],
    ],
  },
];

export const Reads: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <ChapterOut>
      <Area side="left">
        <div style={{ position: "absolute", top: 70 }}>
          <Eyebrow at={6}>Reads the room</Eyebrow>
          <Headline
            at={12}
            size={86}
            text={"No forms.\nIt just *reads the chat.*"}
            style={{ marginTop: 24 }}
          />
        </div>
        {PEOPLE.map((p, i) => (
          <GlassCard
            key={p.name}
            at={p.at}
            from="left"
            style={{
              position: "absolute",
              top: 400 + i * 158,
              left: 0,
              width: 1060,
              padding: "20px 26px",
              display: "flex",
              alignItems: "center",
              gap: 22,
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: "50%",
                background: "linear-gradient(180deg, #a6abb8 0%, #858a96 100%)",
                color: "#fff",
                fontWeight: 800,
                fontSize: 28,
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              {p.name[0]}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
                <span style={{ fontSize: 30, fontWeight: 800 }}>{p.name}</span>
                <span
                  style={{
                    fontSize: 23,
                    color: C.muted,
                    fontStyle: "italic",
                    fontWeight: 600,
                  }}
                >
                  {p.quote}
                </span>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                {p.chips.map(([label, tone], j) => (
                  <Chip key={label} at={p.at + 10 + j * 5} tone={tone}>
                    {label}
                  </Chip>
                ))}
              </div>
            </div>
          </GlassCard>
        ))}
        <div
          style={{
            position: "absolute",
            top: 880,
            left: 0,
            display: "flex",
            alignItems: "center",
            gap: 14,
            opacity: interpolate(frame, [250, 262], [0, 1], clamp),
            translate: `0px ${interpolate(frame, [250, 264], [20, 0], clamp)}px`,
          }}
        >
          <Chip
            at={250}
            tone="good"
            style={{ fontSize: 26, padding: "12px 22px" }}
          >
            🤫 Banter? Atlas stays quiet.
          </Chip>
        </div>
      </Area>
    </ChapterOut>
  );
};
