import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { ChapterOut, Chip, GlassCard, StageBar } from "../../components/Glass";
import { LinkPreview, Place } from "../../components/Photo";
import { Headline } from "../../components/Text";
import { C, clamp, ios } from "../../theme";
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
            alignItems: "flex-start",
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
                  borderRadius: 22,
                  opacity: dim,
                  scale: String(1 + glow * 0.04),
                  boxShadow: won
                    ? `0 0 0 4px ${C.chosen}, 0 24px 60px rgba(47,158,106,${0.35 * glow})`
                    : undefined,
                }}
              >
                <LinkPreview
                  place={o.place}
                  name={o.name}
                  caption={`${o.price} per person · Nov 12–16`}
                  title={o.why}
                  width={358}
                  photoHeight={250}
                  textScale={1.45}
                  style={{ borderRadius: 0 }}
                  aside={
                    <span
                      style={{
                        padding: "6px 14px",
                        borderRadius: 999,
                        fontFamily: ios,
                        fontSize: 19,
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                        background: won ? C.chosen : C.blue,
                        color: "#fff",
                        scale: String(bump),
                      }}
                    >
                      {won ? "✓ " : ""}
                      {votes} vote{votes === 1 ? "" : "s"}
                    </span>
                  }
                />
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
