import React from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, clamp, glassPanel, sans } from "../theme";

// Frosted glass card that pops in at `at`.
export const GlassCard: React.FC<{
  at?: number;
  from?: "below" | "left" | "right" | "scale";
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ at = 0, from = "below", style, children }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [at, at + 20], [0, 1], {
    ...clamp,
    easing: Easing.spring({ damping: 15, mass: 0.9 }),
  });
  const fade = interpolate(frame, [at, at + 8], [0, 1], clamp);
  const off = 1 - p;
  const translate =
    from === "below"
      ? `0px ${off * 60}px`
      : from === "left"
        ? `${-off * 80}px 0px`
        : from === "right"
          ? `${off * 80}px 0px`
          : "0px 0px";
  return (
    <div
      style={{
        ...glassPanel,
        padding: "26px 30px",
        fontFamily: sans,
        color: C.text,
        opacity: fade,
        translate,
        scale:
          from === "scale"
            ? String(interpolate(p, [0, 1], [0.8, 1]))
            : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const Chip: React.FC<{
  at?: number;
  tone?: "accent" | "veto" | "good" | "plain";
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ at = 0, tone = "plain", style, children }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [at, at + 14], [0, 1], {
    ...clamp,
    easing: Easing.spring({ damping: 11 }),
  });
  const colors = {
    accent: {
      bg: "rgba(21,132,196,0.12)",
      fg: C.accent,
      edge: "rgba(21,132,196,0.25)",
    },
    veto: {
      bg: "rgba(210,46,30,0.09)",
      fg: "#b42a1c",
      edge: "rgba(210,46,30,0.22)",
    },
    good: {
      bg: "rgba(47,158,106,0.12)",
      fg: C.chosen,
      edge: "rgba(47,158,106,0.28)",
    },
    plain: {
      bg: "rgba(255,255,255,0.8)",
      fg: C.text,
      edge: "rgba(15,43,60,0.1)",
    },
  }[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 16px",
        borderRadius: 999,
        background: colors.bg,
        color: colors.fg,
        border: `1.5px solid ${colors.edge}`,
        fontFamily: sans,
        fontWeight: 700,
        fontSize: 24,
        whiteSpace: "nowrap",
        opacity: Math.min(1, p * 1.5),
        scale: String(interpolate(p, [0, 1], [0.6, 1])),
        ...style,
      }}
    >
      {children}
    </span>
  );
};

// Fades a chapter's canvas content out over its last frames.
export const ChapterOut: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const p = interpolate(
    frame,
    [durationInFrames - 14, durationInFrames - 2],
    [0, 1],
    { ...clamp, easing: Easing.in(Easing.cubic) },
  );
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: 1 - p,
        filter: p > 0 ? `blur(${p * 14}px)` : undefined,
        scale: String(1 - p * 0.04),
      }}
    >
      {children}
    </div>
  );
};

// The trip page's planning stages: location → dates → travel → stay → food & activities.
export type StageStatus = "open" | "in_progress" | "decided";
export const STAGE_LABELS = [
  "Location",
  "Dates",
  "Travel",
  "Stay",
  "Food & activities",
];

export const StageBar: React.FC<{
  // Frame each stage starts (in progress) and is decided; undefined = never in this view.
  progress: { start?: number; decided?: number; detail?: string }[];
  at?: number;
  width?: number;
  labelSize?: number;
  style?: React.CSSProperties;
}> = ({ progress, at = 0, width = 1100, labelSize = 22, style }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [at, at + 18], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  return (
    <div
      style={{
        width,
        display: "grid",
        gridTemplateColumns: "repeat(5, 1fr)",
        gap: 12,
        fontFamily: sans,
        opacity: p,
        translate: `0px ${(1 - p) * -20}px`,
        ...style,
      }}
    >
      {STAGE_LABELS.map((label, i) => {
        const s = progress[i] ?? {};
        const started = s.start !== undefined && frame >= s.start;
        const decided = s.decided !== undefined && frame >= s.decided;
        const fill = decided
          ? interpolate(frame, [s.decided!, s.decided! + 16], [0.5, 1], {
              ...clamp,
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            })
          : started
            ? interpolate(frame, [s.start!, s.start! + 16], [0, 0.5], {
                ...clamp,
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              })
            : 0;
        const flash = decided
          ? interpolate(frame, [s.decided!, s.decided! + 20], [1, 0], clamp)
          : 0;
        return (
          <div key={label}>
            <div
              style={{
                height: 12,
                borderRadius: 6,
                background: C.track,
                overflow: "hidden",
                boxShadow: "inset 0 1px 1px rgba(0,0,0,0.06)",
              }}
            >
              <div
                style={{
                  width: `${fill * 100}%`,
                  height: "100%",
                  borderRadius: 6,
                  background: decided
                    ? `linear-gradient(180deg, ${C.accentLight}, ${C.accent})`
                    : C.accent,
                  boxShadow: flash
                    ? `0 0 ${18 * flash}px ${C.accentLight}`
                    : undefined,
                }}
              />
            </div>
            <div
              style={{
                fontSize: labelSize,
                lineHeight: 1.2,
                fontWeight: decided || started ? 800 : 600,
                color:
                  started && !decided ? C.accent : decided ? C.text : C.muted,
                marginTop: 8,
              }}
            >
              {label}
            </div>
            <div
              style={{
                fontSize: 18,
                color: decided ? C.text : C.muted,
                minHeight: 24,
                opacity: decided ? 1 : 0.0,
              }}
            >
              {decided ? s.detail : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
};
