import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { ChapterOut, GlassCard, StageBar } from "../../components/Glass";
import { Scenery } from "../../components/Scenery";
import { Headline } from "../../components/Text";
import { C, clamp } from "../../theme";
import { Area } from "./Area";

const TRAVEL = 50;
const STAYS = 96;
const BOOKED = 178;

export const Stay: React.FC = () => {
  const frame = useCurrentFrame();
  const stamp = interpolate(frame, [BOOKED, BOOKED + 14], [0, 1], {
    ...clamp,
    easing: Easing.spring({ damping: 9 }),
  });
  return (
    <ChapterOut>
      <Area side="left">
        <StageBar
          at={4}
          width={1080}
          style={{ position: "absolute", top: 70 }}
          progress={[
            { start: -99, decided: -99, detail: "Charleston" },
            { start: -99, decided: -99, detail: "Nov 12–16" },
            { start: 0, decided: TRAVEL, detail: "Carpool + drive" },
            { start: STAYS, decided: BOOKED, detail: "Townhouse" },
            {},
          ]}
        />
        <Headline
          at={10}
          size={86}
          text={"Travel, sorted.\nThe stay, *booked.*"}
          style={{ position: "absolute", top: 196 }}
        />

        <GlassCard
          at={TRAVEL + 4}
          from="left"
          style={{
            position: "absolute",
            top: 440,
            left: 0,
            width: 500,
            padding: "22px 26px",
          }}
        >
          <div
            style={{
              fontSize: 18,
              fontWeight: 800,
              letterSpacing: "0.1em",
              color: C.accent,
              textTransform: "uppercase",
            }}
          >
            Getting there 🚗
          </div>
          {[
            ["Maya + Leo", "Carpool from Raleigh/Durham", "~4h · ~$31 each"],
            ["Priya", "Drive from Charlotte", "~3h · ~$38 gas"],
          ].map(([who, how, cost], i) => (
            <div
              key={who}
              style={{
                padding: "14px 0 4px",
                borderTop: i ? `1.5px solid ${C.rule}` : undefined,
                marginTop: i ? 10 : 6,
                opacity: interpolate(
                  frame,
                  [TRAVEL + 10 + i * 8, TRAVEL + 20 + i * 8],
                  [0, 1],
                  clamp,
                ),
              }}
            >
              <div style={{ fontSize: 28, fontWeight: 800 }}>{who}</div>
              <div style={{ fontSize: 22, color: C.muted, fontWeight: 600 }}>
                {how} · {cost}
              </div>
            </div>
          ))}
        </GlassCard>

        <GlassCard
          at={STAYS + 4}
          from="right"
          style={{
            position: "absolute",
            top: 440,
            left: 530,
            width: 540,
            padding: 0,
            overflow: "hidden",
          }}
        >
          <div style={{ position: "relative" }}>
            <Scenery place="charleston" height={230} />
            <div
              style={{
                position: "absolute",
                right: 18,
                top: 18,
                padding: "10px 18px",
                borderRadius: 999,
                background: C.chosen,
                color: "#fff",
                fontWeight: 900,
                fontSize: 24,
                rotate: `${(1 - stamp) * -20 + 4}deg`,
                scale: String(interpolate(stamp, [0, 1], [2.2, 1])),
                opacity: Math.min(1, stamp * 2),
                boxShadow: "0 8px 20px rgba(47,158,106,0.4)",
              }}
            >
              Booked ✓
            </div>
          </div>
          <div style={{ padding: "18px 26px 24px" }}>
            <div
              style={{
                fontSize: 31,
                fontWeight: 800,
                letterSpacing: "-0.02em",
              }}
            >
              Harleston Village Townhouse
            </div>
            <div
              style={{
                fontSize: 22,
                color: C.muted,
                fontWeight: 600,
                marginTop: 4,
              }}
            >
              Whole place · sleeps 6 · ★4.8 · Nov 12–16
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 12,
                marginTop: 12,
              }}
            >
              <span style={{ fontSize: 40, fontWeight: 900, color: C.accent }}>
                $413.33
              </span>
              <span style={{ fontSize: 22, color: C.muted, fontWeight: 700 }}>
                each · $1,240 total, on the trip fund
              </span>
            </div>
          </div>
        </GlassCard>
      </Area>
    </ChapterOut>
  );
};
