import React from "react";
import { AbsoluteFill } from "remotion";
import { Phone, PHONE_H, PHONE_W } from "./chat/Phone";
import { Msg } from "./chat/types";
import { Backdrop, Sparkle } from "./components/Backdrop";
import { StageBar } from "./components/Glass";
import { AtlasOrb } from "./components/Logo";
import { PlacePhoto } from "./components/Photo";
import { Headline } from "./components/Text";
import { accentText, C, glassPanel, ios, mono, sans } from "./theme";
import { CapitalOneTile } from "./scenes/chat/Area";

// Apple-style bento marketing sheet. Rendered as a still at the last frame, once every
// entrance animation has settled: npx remotion still BentoSheet out/atlas-bento.png --frame=119
export const BENTO = { width: 2400, height: 2160, frames: 120 };

const PAD = 72;
const GAP = 24;
const HEADER = 270;
const COLS = 6;
const ROWS = 5;
const COL_W = (BENTO.width - PAD * 2 - GAP * (COLS - 1)) / COLS;
const ROW_H = (BENTO.height - PAD * 2 - HEADER - GAP * (ROWS - 1)) / ROWS;

const Tile: React.FC<{
  col: number;
  row: number;
  w?: number;
  h?: number;
  tone?: "glass" | "navy" | "ink" | "sky";
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ col, row, w = 1, h = 1, tone = "glass", style, children }) => {
  const bg: React.CSSProperties =
    tone === "navy"
      ? {
          background: `linear-gradient(160deg, ${C.navy} 0%, ${C.navyDeep} 100%)`,
          color: "#fff",
          border: "1.5px solid rgba(255,255,255,0.15)",
        }
      : tone === "ink"
        ? {
            background: "linear-gradient(160deg, #163a50 0%, #0b2433 100%)",
            color: "#e4f1f8",
            border: "1.5px solid rgba(255,255,255,0.12)",
          }
        : tone === "sky"
          ? {
              background: "linear-gradient(180deg, #bfe6fa 0%, #e8f5fc 100%)",
              border: `1.5px solid ${C.glassEdge}`,
            }
          : {};
  return (
    <div
      style={{
        ...glassPanel,
        borderRadius: 40,
        position: "absolute",
        left: PAD + (col - 1) * (COL_W + GAP),
        top: PAD + HEADER + (row - 1) * (ROW_H + GAP),
        width: COL_W * w + GAP * (w - 1),
        height: ROW_H * h + GAP * (h - 1),
        padding: 40,
        overflow: "hidden",
        fontFamily: sans,
        color: C.text,
        ...bg,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const Kicker: React.FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = C.accent,
}) => (
  <div
    style={{
      fontFamily: sans,
      fontSize: 26,
      fontWeight: 800,
      letterSpacing: "-0.01em",

      color,
      display: "flex",
      alignItems: "center",
      gap: 12,
    }}
  >
    {children}
  </div>
);

const Big: React.FC<{
  children: React.ReactNode;
  size?: number;
  style?: React.CSSProperties;
}> = ({ children, size = 50, style }) => (
  <div
    style={{
      fontSize: size,
      fontWeight: 800,
      letterSpacing: "-0.03em",
      lineHeight: 1.06,
      marginTop: 14,
      ...style,
    }}
  >
    {children}
  </div>
);

const Body: React.FC<{
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, style }) => (
  <div
    style={{
      fontSize: 25,
      fontWeight: 600,
      lineHeight: 1.35,
      color: C.muted,
      marginTop: 12,
      ...style,
    }}
  >
    {children}
  </div>
);

const Icon: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      width: 84,
      height: 84,
      borderRadius: 24,
      display: "grid",
      placeItems: "center",
      fontSize: 46,
      background:
        "radial-gradient(circle at 35% 25%, #ffffff, #d8eef9 60%, #b5dcf1)",
      boxShadow:
        "inset 0 -6px 14px rgba(92,196,244,0.3), 0 8px 20px rgba(14,60,90,0.1)",
    }}
  >
    {children}
  </div>
);

const PHONE_CHAT: Msg[] = [
  { kind: "text", at: 0, from: "maya", text: "atlas give us some options" },
  {
    kind: "text",
    at: 4,
    from: "atlas",
    text: "three options for nov 12–16, per person (estimates):\n1. Charleston · ~$520 · beach + big food scene\n2. Savannah · ~$555 · walkable, veg friendly\n3. Wilmington · ~$470 · beach, short drive",
  },
  {
    kind: "poll",
    at: 8,
    from: "atlas",
    title: "where are we going? 🗳️",
    options: [
      {
        label: "Charleston",
        votes: [
          { who: "maya", at: 10 },
          { who: "leo", at: 12 },
        ],
      },
      { label: "Savannah", votes: [{ who: "priya", at: 14 }] },
      { label: "Wilmington", votes: [] },
    ],
  },
  {
    kind: "text",
    at: 16,
    from: "atlas",
    text: "🎉 charleston it is! 2 of 3 votes. locked in for nov 12–16",
  },
  {
    kind: "text",
    at: 20,
    from: "leo",
    text: "LETS GOOO 🌊",
    react: { emoji: "❤️", at: 22 },
  },
];

export const BentoSheet: React.FC = () => {
  const phoneTileW = COL_W * 2 + GAP;
  const phoneTileH = ROW_H * 3 + GAP * 2;
  const phoneScale = Math.min(
    (phoneTileH - 70) / PHONE_H,
    (phoneTileW - 60) / PHONE_W,
  );
  return (
    <AbsoluteFill>
      <Backdrop seed="bento" bubbles={10} />

      {/* header */}
      <div
        style={{
          position: "absolute",
          left: PAD,
          top: PAD + 6,
          right: PAD,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
        }}
      >
        <div>
          <Kicker>Introducing Atlas</Kicker>
          <Headline
            at={-100}
            size={104}
            text={"Your group chat's *new favorite member.*"}
            style={{ marginTop: 16 }}
          />
        </div>
        <div
          style={{
            fontFamily: sans,
            fontSize: 28,
            fontWeight: 600,
            color: C.muted,
            textAlign: "right",
            lineHeight: 1.4,
            paddingBottom: 18,
          }}
        >
          Plan the trip. Split the bill.
          <br />
          <span style={{ ...accentText, fontWeight: 800 }}>Stay friends.</span>
        </div>
      </div>

      {/* hero */}
      <Tile
        col={1}
        row={1}
        w={2}
        h={2}
        tone="sky"
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <AtlasOrb
            size={130}
            spin={22}
            style={{ filter: "drop-shadow(0 16px 30px rgba(21,132,196,0.35))" }}
          />
          <div
            style={{ fontSize: 120, fontWeight: 900, letterSpacing: "-0.05em" }}
          >
            Atlas
          </div>
        </div>
        <div>
          <Big size={58}>
            The friend who{" "}
            <span style={accentText}>actually plans the trip.</span>
          </Big>
          <Body style={{ fontSize: 28 }}>
            An AI trip &amp; money planner that lives in your iMessage group
            chat. Add its number. No app, no forms.
          </Body>
          <div
            style={{
              display: "flex",
              gap: 10,
              marginTop: 22,
              flexWrap: "wrap",
            }}
          >
            {[
              "Where to go",
              "How to get there",
              "Where to stay",
              "Food & activities",
              "Who owes who",
            ].map((t) => (
              <span
                key={t}
                style={{
                  padding: "8px 16px",
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.85)",
                  border: `1.5px solid ${C.rule}`,
                  fontSize: 21,
                  fontWeight: 700,
                }}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </Tile>

      {/* phone */}
      <Tile col={3} row={1} w={2} h={3} tone="sky" style={{ padding: 0 }}>
        <Phone
          messages={PHONE_CHAT}
          sounds={false}
          style={{
            left: (phoneTileW - PHONE_W * phoneScale) / 2,
            top: 40,
            transformOrigin: "0 0",
            scale: String(phoneScale),
          }}
        />
        <Sparkle x={70} y={120} size={40} delay={-100} />
        <Sparkle
          x={phoneTileW - 70}
          y={phoneTileH - 160}
          size={34}
          delay={-80}
        />
      </Tile>

      {/* Capital One Nessie budgets */}
      <Tile col={5} row={1} w={2} h={2} tone="navy">
        <Kicker color="#9fd8f5">
          <CapitalOneTile size={34} /> Capital One Nessie
        </Kicker>
        <Big size={58} style={{ color: "#fff" }}>
          Budgets from real account data.
        </Big>
        <div style={{ marginTop: 26 }}>
          {[
            ["What you earn", "$3,700/mo"],
            ["Minus bills & everyday spending", "−$2,420/mo"],
            ["Half of what's left, until the trip", "$640"],
          ].map(([l, v], i) => (
            <div
              key={l}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 14,
                padding: "12px 0",
                borderTop: i ? "1.5px solid rgba(255,255,255,0.14)" : undefined,
              }}
            >
              <span
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.14)",
                  display: "grid",
                  placeItems: "center",
                  fontWeight: 900,
                  fontSize: 19,
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <span
                style={{
                  flex: 1,
                  fontSize: 25,
                  fontWeight: 600,
                  color: "rgba(255,255,255,0.75)",
                }}
              >
                {l}
              </span>
              <span
                style={{
                  fontSize: i === 2 ? 44 : 28,
                  fontWeight: 900,
                  color: i === 2 ? "#7fd3ff" : "#fff",
                }}
              >
                {v}
              </span>
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 23,
            fontWeight: 600,
            color: "rgba(255,255,255,0.75)",
            lineHeight: 1.4,
          }}
        >
          Each person connects once. Atlas reads balances and three months of
          transactions and suggests a budget they can actually afford.
        </div>
        <div
          style={{
            position: "absolute",
            left: 40,
            right: 40,
            bottom: 34,
            fontFamily: mono,
            fontSize: 18,
            color: "#9fd8f5",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>GET /accounts/{"{id}"}/purchases</span>
          <span style={{ color: "#7ee2a8" }}>200</span>
        </div>
      </Tile>

      {/* trip fund */}
      <Tile col={1} row={3} w={2}>
        <Kicker>
          <CapitalOneTile size={30} /> Trip fund
        </Kicker>
        <Big>
          Fills itself <span style={accentText}>on payday.</span>
        </Big>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            marginTop: 20,
          }}
        >
          <span
            style={{ fontSize: 56, fontWeight: 900, letterSpacing: "-0.03em" }}
          >
            $1,240
          </span>
          <span style={{ fontSize: 24, fontWeight: 700, color: C.muted }}>
            of $1,240 · stay paid ✓
          </span>
        </div>
        <div
          style={{
            height: 14,
            borderRadius: 7,
            background: C.track,
            marginTop: 12,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              background: `linear-gradient(180deg, #6fe0a8, ${C.chosen})`,
            }}
          />
        </div>
        <Body>Its own Nessie account. It pays for the stay.</Body>
      </Tile>

      {/* split */}
      <Tile col={5} row={3} w={2}>
        <Kicker>Split &amp; settle</Kicker>
        <Big>
          Split it in a text. Settle in the{" "}
          <span style={accentText}>fewest transfers.</span>
        </Big>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginTop: 24,
          }}
        >
          <span
            style={{
              background: `linear-gradient(180deg, ${C.blueTop}, ${C.blue})`,
              color: "#fff",
              borderRadius: 22,
              padding: "10px 18px",
              fontFamily: ios,
              fontSize: 24,
            }}
          >
            i paid 90 for dinner
          </span>
          <span style={{ fontSize: 28, fontWeight: 900, color: C.chosen }}>
            3 debts → 2 transfers
          </span>
        </div>
        <Body>Nothing moves until the payer confirms.</Body>
      </Tile>

      {/* stages */}
      <Tile col={1} row={4} w={2}>
        <Kicker>One plan, five stages</Kicker>
        <Big size={44}>From “we should go somewhere” to booked.</Big>
        <StageBar
          at={-100}
          width={COL_W * 2 + GAP - 80}
          labelSize={19}
          style={{ marginTop: 26, gap: 8 }}
          progress={[
            { start: -99, decided: -99, detail: "Charleston" },
            { start: -99, decided: -99, detail: "Nov 12–16" },
            { start: -99, decided: -99, detail: "Carpool" },
            { start: -99, decided: -99, detail: "Townhouse" },
            { start: -99, decided: -99, detail: "3 picks" },
          ]}
        />
      </Tile>

      {/* small features */}
      <Tile col={3} row={4}>
        <Icon>🗳️</Icon>
        <Big size={36}>Native iMessage polls</Big>
        <Body>A majority locks it in.</Body>
      </Tile>
      <Tile col={4} row={4}>
        <Icon>🤫</Icon>
        <Big size={36}>Knows when to be quiet</Big>
        <Body>Banter gets silence.</Body>
      </Tile>
      <Tile col={5} row={4}>
        <Icon>🌧️</Icon>
        <Big size={36}>Watches the forecast</Big>
        <Body>Rain on beach day? It offers a swap.</Body>
      </Tile>
      <Tile col={6} row={4}>
        <Icon>🧠</Icon>
        <Big size={36}>Remembers weeks later</Big>
        <Body>Hybrid search on Tiger Data.</Body>
      </Tile>

      {/* trip page */}
      <Tile
        col={1}
        row={5}
        w={3}
        style={{ display: "flex", gap: 36, alignItems: "center" }}
      >
        <div style={{ flex: 1 }}>
          <Kicker>Trip page</Kicker>
          <Big>
            Every trip gets <span style={accentText}>its own page.</span>
          </Big>
          <Body>
            The itinerary, picks and fund, written by Atlas and linked in the
            chat with a preview card.
          </Body>
        </div>
        <div
          style={{
            width: 430,
            borderRadius: 26,
            overflow: "hidden",
            position: "relative",
            flexShrink: 0,
            border: `1.5px solid ${C.glassEdge}`,
            boxShadow: "0 16px 40px rgba(14,60,90,0.16)",
          }}
        >
          <PlacePhoto place="charleston" height={240} />
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
              bottom: 14,
              color: "#fff",
            }}
          >
            <div style={{ fontSize: 40, fontWeight: 800 }}>Charleston</div>
            <div style={{ fontSize: 18, fontWeight: 600, opacity: 0.9 }}>
              Nov 12–16 · Maya, Leo, Priya
            </div>
          </div>
        </div>
      </Tile>
      <Tile col={4} row={5}>
        <Icon>🔒</Icon>
        <Big size={36}>Private by default</Big>
        <Body>The group sees pooled numbers only.</Body>
      </Tile>
      <Tile col={5} row={5} tone="ink">
        <div
          style={{
            fontSize: 84,
            fontWeight: 900,
            lineHeight: 1,
            ...accentText,
            backgroundImage: "linear-gradient(180deg, #bff0ff, #5cc0f0)",
          }}
        >
          $
        </div>
        <Big size={36} style={{ color: "#fff" }}>
          Every dollar is traced
        </Big>
        <Body style={{ color: "#8eaabb" }}>
          To a bank call or a labeled estimate.
        </Body>
      </Tile>
      <Tile col={6} row={5}>
        <Kicker color={C.muted}>Built on</Kicker>
        <div
          style={{
            marginTop: 14,
            fontSize: 25,
            fontWeight: 800,
            lineHeight: 1.5,
          }}
        >
          {[
            "Photon Spectrum",
            "Capital One Nessie",
            "Google Gemini",
            "Tiger Data",
          ].map((s) => (
            <div key={s}>{s}</div>
          ))}
        </div>
      </Tile>
    </AbsoluteFill>
  );
};
