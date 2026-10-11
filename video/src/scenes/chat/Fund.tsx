import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { ChapterOut, GlassCard } from "../../components/Glass";
import { Eyebrow, Headline } from "../../components/Text";
import { C, clamp, mono } from "../../theme";
import { Area, CapitalOneTile } from "./Area";

// The trip fund: its own Nessie customer and account, filled by payday transfers, paying for the stay.
const PAYDAY = 112;
const FULL = 186;
const TARGET = 1240;

const API: [number, string, string][] = [
  [26, "POST /customers", "201"],
  [36, "POST /customers/{fund}/accounts", "201"],
  [116, "POST /accounts/{maya}/transfers", "201"],
  [122, "POST /accounts/{leo}/transfers", "201"],
  [128, "POST /accounts/{priya}/transfers", "201"],
  [176, "POST /accounts/{…}/transfers  ×6", "201"],
  [190, "POST /accounts/{fund}/purchases", "201"],
];

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export const Fund: React.FC = () => {
  const frame = useCurrentFrame();
  const amount = interpolate(
    frame,
    [PAYDAY, PAYDAY + 20, FULL - 10, FULL + 6],
    [0, 413.34, 413.34, TARGET],
    { ...clamp, easing: Easing.out(Easing.cubic) },
  );
  const pct = amount / TARGET;
  const member = interpolate(
    frame,
    [PAYDAY, PAYDAY + 20, FULL - 10, FULL + 6],
    [0, 137.78, 137.78, 413.33],
    { ...clamp, easing: Easing.out(Easing.cubic) },
  );
  const paid = frame >= FULL + 8;
  return (
    <ChapterOut>
      <Area side="right">
        <div style={{ position: "absolute", top: 64 }}>
          <Eyebrow at={6} icon={<CapitalOneTile size={30} />}>
            Capital One Nessie
          </Eyebrow>
          <Headline
            at={12}
            size={86}
            text={"A trip fund that\n*fills itself* on payday."}
            style={{ marginTop: 24 }}
          />
        </div>

        <GlassCard
          at={30}
          style={{
            position: "absolute",
            top: 400,
            left: 0,
            width: 640,
            padding: "26px 30px 22px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 17,
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: C.accent,
                }}
              >
                Capital One · Trip fund
              </div>
              <div
                style={{
                  fontSize: 34,
                  fontWeight: 800,
                  letterSpacing: "-0.02em",
                  marginTop: 2,
                }}
              >
                Charleston Trip Fund
              </div>
            </div>
            <div
              style={{
                fontSize: 24,
                fontWeight: 800,
                color: pct >= 1 ? C.chosen : C.muted,
                fontVariantNumeric: "tabular-nums",
                paddingTop: 6,
              }}
            >
              {Math.round(pct * 100)}%
            </div>
          </div>
          <div
            style={{
              margin: "18px 0 12px",
              fontSize: 24,
              color: C.muted,
              fontWeight: 600,
            }}
          >
            <span
              style={{
                fontSize: 58,
                fontWeight: 900,
                color: C.text,
                letterSpacing: "-0.03em",
                fontVariantNumeric: "tabular-nums",
                marginRight: 8,
              }}
            >
              {usd(Math.round(amount))}
            </span>
            of $1,240
          </div>
          <div
            style={{
              height: 16,
              borderRadius: 8,
              background: C.track,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${pct * 100}%`,
                height: "100%",
                borderRadius: 8,
                background:
                  pct >= 1
                    ? `linear-gradient(180deg, #6fe0a8, ${C.chosen})`
                    : `linear-gradient(180deg, ${C.accentLight}, ${C.accent})`,
                boxShadow: `0 0 18px ${pct >= 1 ? "rgba(47,158,106,0.5)" : "rgba(92,196,244,0.6)"}`,
              }}
            />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 18,
              marginTop: 22,
            }}
          >
            {["Maya", "Leo", "Priya"].map((n) => (
              <div
                key={n}
                style={{ borderTop: `1.5px solid ${C.rule}`, paddingTop: 12 }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                  }}
                >
                  <span style={{ fontWeight: 800, fontSize: 24 }}>{n}</span>
                  <span
                    style={{
                      fontSize: 19,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {usd(Math.round(member * 100) / 100)}
                  </span>
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: C.track,
                    marginTop: 8,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${(member / 413.33) * 100}%`,
                      height: "100%",
                      background: C.chosen,
                      borderRadius: 3,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: 20,
              display: "flex",
              justifyContent: "space-between",
              fontSize: 22,
              fontWeight: 700,
              padding: "12px 16px",
              borderRadius: 14,
              background: paid ? "rgba(47,158,106,0.1)" : "rgba(15,43,60,0.04)",
              color: paid ? C.chosen : C.muted,
            }}
          >
            <span>Harleston Village Townhouse</span>
            <span>
              {paid ? "Paid from the fund ✓" : "Booked · pays when covered"}
            </span>
          </div>
        </GlassCard>

        <GlassCard
          at={22}
          from="right"
          style={{
            position: "absolute",
            top: 400,
            left: 670,
            width: 460,
            padding: "20px 22px",
            background: "rgba(15,43,60,0.88)",
            border: "1.5px solid rgba(255,255,255,0.18)",
          }}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: 15,
              color: "#5d7f93",
              marginBottom: 8,
            }}
          >
            capital one nessie api · live
          </div>
          <div
            style={{
              fontFamily: mono,
              fontSize: 17,
              color: "#9fd8f5",
              height: 330,
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-start",
            }}
          >
            {API.filter(([t]) => frame >= t).map(([t, path, code]) => (
              <div
                key={t}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  lineHeight: 1.45,
                  padding: "5px 0",
                  borderTop: "1px solid rgba(255,255,255,0.07)",
                  opacity: interpolate(frame, [t, t + 6], [0, 1], clamp),
                  translate: `${interpolate(frame, [t, t + 8], [16, 0], clamp)}px 0px`,
                }}
              >
                <span>{path}</span>
                <span style={{ color: "#7ee2a8" }}>{code}</span>
              </div>
            ))}
          </div>
          <div
            style={{
              fontFamily: mono,
              fontSize: 15,
              color: "#7ee2a8",
              opacity: interpolate(
                frame,
                [FULL + 10, FULL + 18],
                [0, 1],
                clamp,
              ),
            }}
          >
            ✓ fund covers the stay
          </div>
        </GlassCard>
      </Area>
    </ChapterOut>
  );
};
