import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { accentText, C, clamp, glassPanel, sans } from "../theme";

// A headline whose words rise in one after another. Wrap a word in *asterisks* to give it the
// aqua accent. `out` is the frame the headline leaves (optional).
export const Headline: React.FC<{
  text: string;
  at?: number;
  out?: number;
  size?: number;
  align?: "left" | "center";
  stagger?: number;
  style?: React.CSSProperties;
}> = ({ text, at = 0, out, size = 92, align = "left", stagger = 3, style }) => {
  const frame = useCurrentFrame();
  const lines = text.split("\n");
  let n = 0;
  // *accent* can span several words.
  let inAccent = false;
  const leave =
    out === undefined
      ? 0
      : interpolate(frame, [out, out + 10], [0, 1], {
          ...clamp,
          easing: Easing.in(Easing.cubic),
        });
  return (
    <div
      style={{
        fontFamily: sans,
        fontWeight: 800,
        fontSize: size,
        lineHeight: 1.04,
        letterSpacing: "-0.035em",
        color: C.text,
        textAlign: align,
        opacity: 1 - leave,
        translate: `0px ${-30 * leave}px`,
        filter: leave > 0 ? `blur(${leave * 10}px)` : undefined,
        ...style,
      }}
    >
      {lines.map((line, li) => (
        <div key={li} style={{ whiteSpace: "nowrap" }}>
          {line.split(" ").map((word, wi) => {
            const i = n++;
            const t = at + i * stagger;
            const p = interpolate(frame, [t, t + 16], [0, 1], {
              ...clamp,
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            });
            const opens = word.startsWith("*");
            const closes = word.endsWith("*") && (word.length > 1 || !opens);
            const accent = inAccent || opens;
            inAccent = accent && !closes;
            const w = word.replace(/^\*|\*$/g, "");
            return (
              <span
                key={wi}
                style={{
                  display: "inline-block",
                  marginRight: "0.24em",
                  opacity: p,
                  translate: `0px ${(1 - p) * 0.55 * size}px`,
                  filter: p < 1 ? `blur(${(1 - p) * 12}px)` : undefined,
                  paddingBottom: "0.08em",
                  ...(accent ? accentText : null),
                }}
              >
                {w}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

// A small glossy glass pill above a headline.
export const Eyebrow: React.FC<{
  children: React.ReactNode;
  at?: number;
  out?: number;
  icon?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ children, at = 0, out, icon, style }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [at, at + 14], [0, 1], {
    ...clamp,
    easing: Easing.spring({ damping: 14 }),
  });
  const leave =
    out === undefined ? 0 : interpolate(frame, [out, out + 10], [0, 1], clamp);
  return (
    <div
      style={{
        ...glassPanel,
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        borderRadius: 999,
        padding: "12px 24px 12px 18px",
        fontFamily: sans,
        fontSize: 28,
        fontWeight: 800,
        letterSpacing: "-0.01em",
        color: C.accent,
        opacity: p * (1 - leave),
        scale: String(interpolate(p, [0, 1], [0.7, 1])),
        transformOrigin: "0% 50%",
        ...style,
      }}
    >
      {icon ?? (
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: `radial-gradient(circle at 35% 30%, #c8f2ff, ${C.accent})`,
            boxShadow: `0 0 12px ${C.accentLight}`,
          }}
        />
      )}
      {children}
    </div>
  );
};

export const Sub: React.FC<{
  children: React.ReactNode;
  at?: number;
  out?: number;
  size?: number;
  style?: React.CSSProperties;
}> = ({ children, at = 0, out, size = 36, style }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [at, at + 18], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const leave =
    out === undefined ? 0 : interpolate(frame, [out, out + 10], [0, 1], clamp);
  return (
    <div
      style={{
        fontFamily: sans,
        fontSize: size,
        fontWeight: 600,
        lineHeight: 1.35,
        color: C.muted,
        opacity: p * (1 - leave),
        translate: `0px ${(1 - p) * 24}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};
