import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { ChapterOut, GlassCard } from "../../components/Glass";
import { Eyebrow, Headline, Sub } from "../../components/Text";
import { C, clamp, mono } from "../../theme";
import { Area, CapitalOneTile } from "./Area";

// Bank connect → Nessie customer and generated history → a private budget, explained in three lines.
const ACCOUNTS = [
  ["Checking", "···4821", "$2,184.20"],
  ["Savings", "···0937", "$3,920.00"],
  ["Quicksilver", "···5520", "−$412.36"],
];

const TXNS: [string, string, boolean][] = [
  ["Paycheck · Oak City Analytics", "+$1,850.00", true],
  ["Rent · Glenwood Apartments", "−$1,150.00", false],
  ["Duke Energy", "−$92.14", false],
  ["Verizon Wireless", "−$65.00", false],
  ["Harris Teeter", "−$48.67", false],
];

const API: [number, string, string][] = [
  [192, "POST /customers", "201"],
  [200, "POST /customers/{id}/accounts", "201"],
  [208, "POST /accounts/{id}/deposits", "201"],
  [216, "POST /accounts/{id}/bills", "201"],
  [224, "POST /accounts/{id}/purchases", "201"],
  [262, "GET  /accounts/{id}/deposits", "200"],
  [270, "GET  /accounts/{id}/bills", "200"],
  [278, "GET  /accounts/{id}/purchases", "200"],
];

const Count: React.FC<{
  from: number;
  to: number;
  at: number;
  dur?: number;
  prefix?: string;
}> = ({ from, to, at, dur = 30, prefix = "$" }) => {
  const frame = useCurrentFrame();
  const v = interpolate(frame, [at, at + dur], [from, to], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      {prefix}
      {Math.round(v).toLocaleString("en-US")}
    </span>
  );
};

export const Connect: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <ChapterOut>
      <Area side="right">
        <div style={{ position: "absolute", top: 64 }}>
          <Eyebrow at={8} icon={<CapitalOneTile size={30} />}>
            Capital One Nessie
          </Eyebrow>
          <Headline
            at={14}
            size={86}
            text={"Budgets from\n*real account data.*"}
            style={{ marginTop: 24 }}
          />
          <Sub
            at={44}
            out={186}
            size={36}
            style={{ marginTop: 30, maxWidth: 1000 }}
          >
            Connect once. Atlas sees balances and three months of transactions,
            and suggests a trip budget you can actually afford.
          </Sub>
        </div>

        <GlassCard
          at={196}
          style={{
            position: "absolute",
            top: 400,
            left: 0,
            width: 540,
            padding: "22px 26px",
          }}
        >
          <div
            style={{
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: "-0.01em",
              color: C.accent,
            }}
          >
            Maya · Capital One
          </div>
          {ACCOUNTS.map(([name, num, bal], i) => (
            <div
              key={name}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                padding: "11px 0",
                borderTop: i ? `1.5px solid ${C.rule}` : undefined,
                fontSize: 26,
                opacity: interpolate(
                  frame,
                  [204 + i * 7, 214 + i * 7],
                  [0, 1],
                  clamp,
                ),
              }}
            >
              <span style={{ fontWeight: 700 }}>
                {name}{" "}
                <span style={{ color: C.muted, fontWeight: 600, fontSize: 21 }}>
                  {num}
                </span>
              </span>
              <span
                style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
              >
                {bal}
              </span>
            </div>
          ))}
        </GlassCard>

        <GlassCard
          at={212}
          style={{
            position: "absolute",
            top: 668,
            left: 0,
            width: 540,
            padding: "20px 26px",
          }}
        >
          <div
            style={{
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: "-0.01em",
              color: C.muted,
            }}
          >
            Last 3 months
          </div>
          {TXNS.map(([label, amt, inflow], i) => (
            <div
              key={label}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 0",
                fontSize: 23,
                borderTop: i ? `1.5px solid ${C.rule}` : undefined,
                opacity: interpolate(
                  frame,
                  [220 + i * 6, 228 + i * 6],
                  [0, 1],
                  clamp,
                ),
                translate: `${interpolate(frame, [220 + i * 6, 232 + i * 6], [30, 0], { ...clamp, easing: Easing.out(Easing.cubic) })}px 0px`,
              }}
            >
              <span style={{ fontWeight: 600 }}>{label}</span>
              <span
                style={{
                  fontWeight: 700,
                  color: inflow ? C.chosen : C.text,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {amt}
              </span>
            </div>
          ))}
        </GlassCard>

        <GlassCard
          at={250}
          from="right"
          style={{
            position: "absolute",
            top: 400,
            left: 580,
            width: 550,
            padding: "24px 28px",
          }}
        >
          <div
            style={{
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: "-0.01em",
              color: C.accent,
            }}
          >
            How Atlas sets a budget
          </div>
          {[
            [
              "What you earn",
              <Count key="a" from={0} to={3700} at={262} />,
              "/mo",
            ],
            [
              "Minus bills & everyday spending",
              <span key="b">
                −<Count from={0} to={2420} at={276} />
              </span>,
              "/mo",
            ],
            [
              "Half of what's left, until the trip",
              <Count key="c" from={0} to={640} at={290} />,
              "",
            ],
          ].map(([label, value, unit], i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 14,
                padding: "12px 0",
                borderTop: i ? `1.5px solid ${C.rule}` : undefined,
                opacity: interpolate(
                  frame,
                  [258 + i * 14, 268 + i * 14],
                  [0, 1],
                  clamp,
                ),
              }}
            >
              <span
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: "50%",
                  background: C.accentSoft,
                  color: C.accent,
                  fontWeight: 900,
                  display: "grid",
                  placeItems: "center",
                  fontSize: 20,
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <span
                style={{
                  flex: 1,
                  fontSize: 23,
                  fontWeight: 600,
                  color: C.muted,
                }}
              >
                {label}
              </span>
              <span
                style={{
                  fontSize: i === 2 ? 38 : 28,
                  fontWeight: 800,
                  color: i === 2 ? C.accent : C.text,
                }}
              >
                {value}
                <span style={{ fontSize: 18, color: C.muted }}>{unit}</span>
              </span>
            </div>
          ))}
          <div
            style={{
              marginTop: 10,
              padding: "12px 16px",
              borderRadius: 16,
              background: "rgba(47,158,106,0.1)",
              color: C.chosen,
              fontWeight: 700,
              fontSize: 22,
              opacity: interpolate(frame, [316, 328], [0, 1], clamp),
            }}
          >
            🔒 Private to Maya. The group only sees pooled numbers.
          </div>
        </GlassCard>

        <GlassCard
          at={188}
          from="right"
          style={{
            position: "absolute",
            top: 836,
            left: 580,
            width: 550,
            padding: "16px 24px",
            background: "rgba(15,43,60,0.86)",
            border: "1.5px solid rgba(255,255,255,0.18)",
          }}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: 17,
              color: "#9fd8f5",
              height: 116,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-end",
            }}
          >
            {API.filter(([t]) => frame >= t).map(([t, path, code]) => (
              <div
                key={t}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  lineHeight: 1.7,
                  opacity: interpolate(frame, [t, t + 5], [0, 1], clamp),
                }}
              >
                <span>
                  <span style={{ color: "#5d7f93" }}>nessie › </span>
                  {path}
                </span>
                <span style={{ color: "#7ee2a8" }}>{code}</span>
              </div>
            ))}
          </div>
        </GlassCard>
      </Area>
    </ChapterOut>
  );
};
