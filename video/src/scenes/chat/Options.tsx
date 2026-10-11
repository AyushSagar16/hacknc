import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { ChapterOut, Chip, GlassCard, StageBar } from "../../components/Glass";
import { Place, Scenery } from "../../components/Scenery";
import { Headline } from "../../components/Text";
import { C, clamp } from "../../theme";
import { Area } from "./Area";

// Must match the poll in chat/script.ts (relative to the options chapter).
const OPTIONS: {
  place: Place;
  name: string;
  price: string;
  why: string;
  votes: number[];
}[] = [
  {
    place: "charleston",
    name: "Charleston",
    price: "~$520",
    why: "Beach + big food scene",
    votes: [130, 158],
  },
  {
    place: "savannah",
    name: "Savannah",
    price: "~$555",
    why: "Walkable, veg friendly",
    votes: [178],
  },
  {
    place: "wilmington",
    name: "Wilmington",
    price: "~$470",
    why: "Beach, short drive",
    votes: [],
  },
];
const LOCK = 222;

export const Options: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <ChapterOut>
      <Area side="right">
        <StageBar
          at={4}
          width={1120}
          style={{ position: "absolute", top: 70 }}
          progress={[
            { start: 0, decided: LOCK, detail: "Charleston" },
            { start: 0, decided: LOCK, detail: "Nov 12–16" },
            {},
            {},
            {},
          ]}
        />
        <Headline
          at={12}
          size={86}
          text={"Three options.\nOne *native poll.*"}
          style={{ position: "absolute", top: 196 }}
        />
        <div
          style={{
            position: "absolute",
            top: 440,
            left: 0,
            display: "flex",
            gap: 22,
          }}
        >
          {OPTIONS.map((o, i) => {
            const votes = o.votes.filter((v) => frame >= v).length;
            const won = frame >= LOCK && i === 0;
            const glow = won
              ? interpolate(frame, [LOCK, LOCK + 16], [0, 1], clamp)
              : 0;
            const dim =
              frame >= LOCK && !won
                ? interpolate(frame, [LOCK, LOCK + 12], [1, 0.55], clamp)
                : 1;
            const lastVote = Math.max(
              -99,
              ...o.votes.filter((v) => frame >= v),
            );
            const bump = interpolate(
              frame,
              [lastVote, lastVote + 12],
              [1.25, 1],
              { ...clamp, easing: Easing.spring({ damping: 8 }) },
            );
            return (
              <GlassCard
                key={o.name}
                at={66 + i * 8}
                style={{
                  width: 358,
                  padding: 0,
                  overflow: "hidden",
                  opacity: dim,
                  scale: String(1 + glow * 0.04),
                  boxShadow: won
                    ? `0 0 0 4px ${C.chosen}, 0 24px 60px rgba(47,158,106,${0.35 * glow})`
                    : undefined,
                }}
              >
                <Scenery place={o.place} height={190} />
                <div style={{ padding: "18px 24px 22px" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 36,
                        fontWeight: 800,
                        letterSpacing: "-0.02em",
                      }}
                    >
                      {o.name}
                    </span>
                    <span
                      style={{ fontSize: 26, fontWeight: 800, color: C.accent }}
                    >
                      {o.price}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 22,
                      color: C.muted,
                      fontWeight: 600,
                      marginTop: 4,
                    }}
                  >
                    {o.why} · per person
                  </div>
                  <div
                    style={{
                      marginTop: 14,
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <span
                      style={{
                        padding: "6px 14px",
                        borderRadius: 999,
                        fontSize: 21,
                        fontWeight: 800,
                        background: won ? C.chosen : C.accentSoft,
                        color: won ? "#fff" : C.accent,
                        scale: String(bump),
                      }}
                    >
                      {won ? "Chosen · " : ""}
                      {votes} vote{votes === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              </GlassCard>
            );
          })}
        </div>
        <div
          style={{
            position: "absolute",
            top: 836,
            left: 0,
            display: "flex",
            gap: 14,
          }}
        >
          <Chip at={104} tone="veto">
            ✕ Cancún never shows up: Leo vetoed it
          </Chip>
          <Chip at={114} tone="accent">
            🚗 All drivable for Priya
          </Chip>
        </div>
      </Area>
    </ChapterOut>
  );
};
