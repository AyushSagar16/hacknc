import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { ChapterOut, Chip } from "../../components/Glass";
import { Eyebrow, Headline } from "../../components/Text";
import { C, clamp, mono, sans } from "../../theme";
import { Area, CapitalOneTile } from "./Area";

// Splits in the chat, then settle-up as the true minimum number of transfers.
// Dinner $90 by Maya (3 ways), Leo's $40 ticket by Priya → Leo owes $70: Maya +$60, Priya +$10.
const LOG1 = 64;
const LOG2 = 132;
const SETTLE = 204;
const SENT = 276;

const NODES = {
  maya: { x: 200, y: 90 },
  priya: { x: 860, y: 90 },
  leo: { x: 530, y: 400 },
} as const;
type N = keyof typeof NODES;

const Edge: React.FC<{
  from: N;
  to: N;
  label: string;
  at: number;
  out?: number;
  good?: number;
  bend?: number;
}> = ({ from, to, label, at, out, good, bend = 0 }) => {
  const frame = useCurrentFrame();
  const a = NODES[from];
  const b = NODES[to];
  const draw = interpolate(frame, [at, at + 18], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.3, 0.8, 0.2, 1),
  });
  const leave =
    out === undefined ? 0 : interpolate(frame, [out, out + 12], [0, 1], clamp);
  const ok =
    good === undefined
      ? 0
      : interpolate(frame, [good, good + 12], [0, 1], clamp);
  if (draw <= 0 || leave >= 1) return null;
  // Trim the line to the node circles (r = 70).
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const sx = a.x + ux * 78;
  const sy = a.y + uy * 78;
  const ex = b.x - ux * 86;
  const ey = b.y - uy * 86;
  const mx = (sx + ex) / 2 - uy * bend;
  const my = (sy + ey) / 2 + ux * bend;
  const color = ok > 0.5 ? C.chosen : C.accent;
  const path = `M${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`;
  const pathLen = len * 1.05;
  return (
    <g opacity={1 - leave}>
      <path
        d={path}
        stroke={color}
        strokeWidth={7}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={pathLen}
        strokeDashoffset={pathLen * (1 - draw)}
      />
      {draw > 0.95 ? (
        <polygon
          points="0,-14 26,0 0,14"
          fill={color}
          transform={`translate(${ex} ${ey}) rotate(${(Math.atan2(ey - my, ex - mx) * 180) / Math.PI})`}
        />
      ) : null}
      <foreignObject
        x={(sx + ex) / 2 - uy * bend * 0.5 - 110}
        y={(sy + ey) / 2 + ux * bend * 0.5 - 30}
        width={220}
        height={60}
        opacity={draw}
      >
        <div
          style={{
            margin: "0 auto",
            width: "fit-content",
            padding: "8px 18px",
            borderRadius: 999,
            background: ok > 0.5 ? C.chosen : "#fff",
            color: ok > 0.5 ? "#fff" : C.text,
            fontFamily: sans,
            fontWeight: 900,
            fontSize: 28,
            boxShadow: "0 6px 18px rgba(14,60,90,0.15)",
            border: `1.5px solid ${ok > 0.5 ? C.chosen : C.rule}`,
            whiteSpace: "nowrap",
          }}
        >
          {label}
          {ok > 0.5 ? " ✓" : ""}
        </div>
      </foreignObject>
    </g>
  );
};

const Node: React.FC<{ who: N; delta: { at: number; v: string }[] }> = ({
  who,
  delta,
}) => {
  const frame = useCurrentFrame();
  const n = NODES[who];
  const p = interpolate(frame, [8, 26], [0, 1], {
    ...clamp,
    easing: Easing.spring({ damping: 12 }),
  });
  const current = [...delta].reverse().find((d) => frame >= d.at);
  return (
    <div
      style={{
        position: "absolute",
        left: n.x - 70,
        top: n.y - 70,
        width: 140,
        height: 140,
        borderRadius: "50%",
        background:
          "radial-gradient(circle at 35% 28%, #ffffff 0%, #e6f3fb 45%, #c4e2f3 100%)",
        border: "2px solid #fff",
        boxShadow:
          "0 16px 40px rgba(14,60,90,0.18), inset 0 -8px 18px rgba(92,196,244,0.25)",
        display: "grid",
        placeItems: "center",
        scale: String(p),
        fontFamily: sans,
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 32, fontWeight: 900, color: C.text }}>
          {who[0].toUpperCase() + who.slice(1)}
        </div>
        {current ? (
          <div
            style={{
              fontSize: 22,
              fontWeight: 800,
              color: current.v.startsWith("+")
                ? C.chosen
                : current.v === "$0"
                  ? C.muted
                  : "#b42a1c",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {current.v}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const Split: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <ChapterOut>
      <Area side="right">
        <div style={{ position: "absolute", top: 64 }}>
          <Eyebrow at={6}>Split &amp; settle up</Eyebrow>
          <Headline
            at={12}
            size={80}
            text={"Split it in a text.\nSettle in the *fewest transfers.*"}
            style={{ marginTop: 24 }}
          />
        </div>
        <div
          style={{
            position: "absolute",
            top: 400,
            left: 40,
            width: 1060,
            height: 560,
          }}
        >
          <svg
            width={1060}
            height={560}
            style={{ position: "absolute", inset: 0, overflow: "visible" }}
          >
            <Edge
              from="leo"
              to="maya"
              label="$30"
              at={LOG1}
              out={SETTLE}
              bend={-40}
            />
            <Edge
              from="priya"
              to="maya"
              label="$30"
              at={LOG1 + 6}
              out={SETTLE}
            />
            <Edge
              from="leo"
              to="priya"
              label="$40"
              at={LOG2}
              out={SETTLE}
              bend={40}
            />
            <Edge
              from="leo"
              to="maya"
              label="$60"
              at={SETTLE + 8}
              good={SENT}
            />
            <Edge
              from="leo"
              to="priya"
              label="$10"
              at={SETTLE + 14}
              good={SENT}
            />
          </svg>
          <Node
            who="maya"
            delta={[
              { at: LOG1, v: "+$60" },
              { at: SENT, v: "$0" },
            ]}
          />
          <Node
            who="priya"
            delta={[
              { at: LOG1, v: "−$30" },
              { at: LOG2, v: "+$10" },
              { at: SENT, v: "$0" },
            ]}
          />
          <Node
            who="leo"
            delta={[
              { at: LOG1, v: "−$30" },
              { at: LOG2, v: "−$70" },
              { at: SENT, v: "$0" },
            ]}
          />
        </div>
        <div
          style={{
            position: "absolute",
            top: 930,
            left: 0,
            display: "flex",
            gap: 14,
            alignItems: "center",
          }}
        >
          <Chip at={SETTLE + 10} tone="accent">
            3 debts → 2 transfers
          </Chip>
          <Chip at={SENT + 4} tone="good">
            <CapitalOneTile size={26} /> Sent after Leo confirmed
          </Chip>
          <span
            style={{
              fontFamily: mono,
              fontSize: 19,
              color: C.muted,
              opacity: interpolate(
                frame,
                [SENT + 10, SENT + 20],
                [0, 1],
                clamp,
              ),
            }}
          >
            POST /accounts/{"{leo}"}/transfers ×2 → 201
          </span>
        </div>
      </Area>
    </ChapterOut>
  );
};
