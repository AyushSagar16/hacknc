import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { ChapterOut, GlassCard, StageBar } from "../../components/Glass";
import { Scenery } from "../../components/Scenery";
import { Headline } from "../../components/Text";
import { C, clamp, glassPanel } from "../../theme";
import { Area } from "./Area";

// The trip's own web page (web/app/t/[id]): Atlas writes the plan onto it as picks come in.
const ADDED = 124;

const DAYS: {
  day: string;
  title: string;
  items: { name: string; time: string; added?: boolean }[];
}[] = [
  {
    day: "Thu, Nov 12",
    title: "Arrive",
    items: [
      { name: "Check in · Harleston Village Townhouse", time: "4pm" },
      { name: "Basic Kitchen · veggie-forward", time: "dinner", added: true },
    ],
  },
  {
    day: "Fri, Nov 13",
    title: "Beach day",
    items: [
      { name: "Folly Beach", time: "morning" },
      { name: "Music Farm · live music", time: "night", added: true },
    ],
  },
];

export const Food: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <ChapterOut>
      <Area side="left">
        <Headline
          at={8}
          size={86}
          text={"Food, things to do,\nand *a page for the plan.*"}
          style={{ position: "absolute", top: 70 }}
        />

        <GlassCard
          at={20}
          style={{
            position: "absolute",
            top: 330,
            left: 0,
            width: 1060,
            padding: 0,
            overflow: "hidden",
            background: "rgba(246,250,253,0.86)",
          }}
        >
          {/* browser chrome */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "14px 20px",
              borderBottom: `1.5px solid ${C.rule}`,
              background: "rgba(255,255,255,0.7)",
            }}
          >
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
              <span
                key={c}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: c,
                }}
              />
            ))}
            <div
              style={{
                marginLeft: 16,
                flex: 1,
                borderRadius: 10,
                background: "rgba(15,43,60,0.06)",
                padding: "6px 16px",
                fontSize: 19,
                color: C.muted,
                fontWeight: 600,
              }}
            >
              🔒 atlas trip page · /t/charleston
            </div>
          </div>
          <div style={{ display: "flex", gap: 24, padding: 24 }}>
            <div style={{ width: 400, flexShrink: 0 }}>
              <div
                style={{
                  position: "relative",
                  borderRadius: 22,
                  overflow: "hidden",
                  border: `1.5px solid ${C.glassEdge}`,
                }}
              >
                <Scenery place="charleston" height={250} />
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    background:
                      "linear-gradient(180deg, rgba(5,25,40,0) 40%, rgba(5,25,40,0.6) 100%)",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: 20,
                    bottom: 16,
                    color: "#fff",
                  }}
                >
                  <div
                    style={{
                      fontSize: 44,
                      fontWeight: 800,
                      letterSpacing: "-0.02em",
                      textShadow: "0 1px 12px rgba(0,0,0,0.25)",
                    }}
                  >
                    Charleston
                  </div>
                  <div style={{ fontSize: 19, opacity: 0.9, fontWeight: 600 }}>
                    Nov 12–16 · Maya, Leo, Priya
                  </div>
                </div>
              </div>
              <StageBar
                width={400}
                labelSize={14}
                style={{ marginTop: 18, gap: 6 }}
                progress={[
                  { start: -99, decided: -99, detail: "" },
                  { start: -99, decided: -99, detail: "" },
                  { start: -99, decided: -99, detail: "" },
                  { start: -99, decided: -99, detail: "" },
                  { start: 0, decided: ADDED },
                ]}
              />
            </div>
            <div
              style={{
                flex: 1,
                ...glassPanel,
                borderRadius: 20,
                padding: "18px 22px",
              }}
            >
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 800,
                  letterSpacing: "0.1em",
                  color: C.muted,
                  textTransform: "uppercase",
                }}
              >
                Itinerary →
              </div>
              {DAYS.map((d) => (
                <div key={d.day} style={{ marginTop: 12 }}>
                  <div
                    style={{ fontSize: 17, fontWeight: 800, color: C.accent }}
                  >
                    {d.day}
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800 }}>{d.title}</div>
                  {d.items.map((it) => {
                    const p = it.added
                      ? interpolate(frame, [ADDED, ADDED + 14], [0, 1], {
                          ...clamp,
                          easing: Easing.bezier(0.16, 1, 0.3, 1),
                        })
                      : 1;
                    const hi = it.added
                      ? interpolate(
                          frame,
                          [ADDED + 4, ADDED + 40],
                          [1, 0],
                          clamp,
                        )
                      : 0;
                    return (
                      <div
                        key={it.name}
                        style={{ display: "grid", gridTemplateRows: `${p}fr` }}
                      >
                        <div style={{ minHeight: 0, overflow: "hidden" }}>
                          <div
                            style={{
                              display: "flex",
                              gap: 14,
                              padding: "7px 8px",
                              margin: "0 -8px",
                              borderRadius: 10,
                              borderTop: `1.5px solid ${C.rule}`,
                              fontSize: 20,
                              background: `rgba(92,196,244,${0.25 * hi})`,
                              opacity: p,
                            }}
                          >
                            <span
                              style={{
                                width: 84,
                                color: C.muted,
                                fontWeight: 600,
                              }}
                            >
                              {it.time}
                            </span>
                            <span style={{ fontWeight: 600 }}>
                              {it.name}{" "}
                              {it.added ? (
                                <span
                                  style={{ color: C.chosen, fontWeight: 800 }}
                                >
                                  ✓
                                </span>
                              ) : null}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </GlassCard>
      </Area>
    </ChapterOut>
  );
};
