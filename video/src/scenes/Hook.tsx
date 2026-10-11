import React from "react";
import { Audio } from "@remotion/media";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  random,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Backdrop } from "../components/Backdrop";
import { Headline, Sub } from "../components/Text";
import { C, clamp, ios } from "../theme";

// Cold open: the group chat every friend group has. Maybes pile up, nothing gets booked.
const CHAOS: [string, string, boolean][] = [
  ["Leo", "we should go somewhere this fall 🌴", false],
  ["Priya", "omg yes", false],
  ["", "where tho", true],
  ["Leo", "cancun??", false],
  ["Priya", "cancun is too pricey for me", false],
  ["", "i can't fly after the 14th", true],
  ["Leo", "who's driving", false],
  ["Priya", "idk i'm broke till payday", false],
  ["", "maybe nov?", true],
  ["Leo", "i'm vegetarian btw", false],
  ["Priya", "beach!!!", false],
  ["Leo", "mountains > beach", false],
  ["", "someone make a doc", true],
  ["Priya", "wait what dates", false],
  ["Leo", "who's booking", false],
  ["", "venmo me later", true],
  ["Priya", "did anyone look at airbnbs", false],
  ["Leo", "👀", false],
  ["", "are we still doing this", true],
  ["Priya", "can't do the 12th", false],
  ["Leo", "bump", false],
  ["", "hello??", true],
  ["Priya", "ok so nobody booked anything", false],
  ["Leo", "lol", false],
];

const COLS = 6;
const ROWS = 4;

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Bubbles land faster and faster.
  const times = CHAOS.map(
    (_, i) => Math.round(110 * Math.pow(i / CHAOS.length, 0.75)) + 4,
  );
  const settle = interpolate(frame, [124, 150], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.65, 0, 0.35, 1),
  });

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Backdrop seed="hook" bubbles={4} grid={false} />
      <AbsoluteFill
        style={{
          filter: `blur(${settle * 9}px)`,
          opacity: 1 - settle * 0.62,
          scale: String(1 + settle * 0.08),
        }}
      >
        {CHAOS.map(([name, text, mine], i) => {
          const t = times[i];
          if (frame < t) return null;
          const cell = i % (COLS * ROWS);
          const cx = (cell % COLS) * (1920 / COLS) + 30 + random(`x${i}`) * 90;
          const cy =
            Math.floor(cell / COLS) * (1080 / ROWS) +
            60 +
            random(`y${i}`) * 110;
          const pop = interpolate(frame, [t, t + 12], [0, 1], {
            ...clamp,
            easing: Easing.spring({ damping: 11, mass: 0.6 }),
          });
          const drift = (frame - t) * (random(`d${i}`) - 0.5) * 0.5;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: cx + drift,
                top: cy - (frame - t) * 0.25,
                scale: String(pop),
                rotate: `${(random(`r${i}`) - 0.5) * 8}deg`,
                transformOrigin: mine ? "100% 100%" : "0% 100%",
                fontFamily: ios,
              }}
            >
              {name ? (
                <div
                  style={{
                    fontSize: 17,
                    color: "#8e8e93",
                    margin: "0 0 3px 14px",
                  }}
                >
                  {name}
                </div>
              ) : null}
              <div
                style={{
                  maxWidth: 380,
                  padding: "12px 20px",
                  borderRadius: 26,
                  fontSize: 27,
                  letterSpacing: -0.3,
                  background: mine
                    ? `linear-gradient(180deg, ${C.blueTop}, ${C.blue})`
                    : C.gray,
                  color: mine ? "#fff" : "#000",
                  boxShadow: "0 10px 30px rgba(14,60,90,0.12)",
                }}
              >
                {text}
              </div>
            </div>
          );
        })}
      </AbsoluteFill>

      {/* unread counter */}
      <div
        style={{
          position: "absolute",
          top: 44,
          left: "50%",
          translate: "-50% 0",
          padding: "10px 24px",
          borderRadius: 999,
          background: "#ff3b30",
          color: "#fff",
          fontFamily: ios,
          fontWeight: 700,
          fontSize: 28,
          opacity: interpolate(frame, [10, 18, 124, 140], [0, 1, 1, 0], clamp),
          boxShadow: "0 8px 24px rgba(255,59,48,0.35)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {Math.round(interpolate(frame, [10, 124], [1, 47], clamp))} unread
      </div>

      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <Headline
          at={140}
          align="center"
          size={112}
          text={"Every group chat has a trip\nthat *never happens.*"}
        />
        <Sub at={192} size={42} style={{ marginTop: 34, textAlign: "center" }}>
          47 messages. 3 opinions. 0 bookings.
        </Sub>
      </AbsoluteFill>

      {CHAOS.slice(0, 14).map((_, i) => (
        <Sequence
          key={i}
          name="sfx pop"
          from={times[i]}
          durationInFrames={fps}
          premountFor={fps}
        >
          <Audio
            src={staticFile("audio/receive.wav")}
            volume={interpolate(i, [0, 13], [0.45, 0.18])}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
