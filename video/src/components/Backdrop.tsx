import React from "react";
import { AbsoluteFill, interpolate, random, useCurrentFrame } from "remotion";
import { C } from "../theme";

// The site's sky: a pale gradient, two soft light orbs, plus a few Y2K extras kept faint
// (a perspective grid and glossy aero bubbles drifting up).
export const Backdrop: React.FC<{
  grid?: boolean;
  bubbles?: number;
  seed?: string;
}> = ({ grid = true, bubbles = 7, seed = "sky" }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(180deg, ${C.skyTop} 0%, ${C.skyBottom} 70%)`,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 1100,
          height: 1100,
          borderRadius: "50%",
          background: C.orbA,
          filter: "blur(120px)",
          left: 1100 + Math.sin(frame / 90) * 80,
          top: -420 + Math.cos(frame / 110) * 60,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 900,
          height: 900,
          borderRadius: "50%",
          background: C.orbB,
          filter: "blur(120px)",
          left: -360 + Math.cos(frame / 100) * 70,
          top: 520 + Math.sin(frame / 80) * 50,
        }}
      />
      {grid ? <Grid /> : null}
      {new Array(bubbles).fill(0).map((_, i) => (
        <AeroBubble key={i} seed={`${seed}-${i}`} />
      ))}
    </AbsoluteFill>
  );
};

// A floor grid in perspective, faded out toward the horizon.
const Grid: React.FC = () => {
  const frame = useCurrentFrame();
  const scroll = (frame * 0.6) % 80;
  return (
    <div
      style={{
        position: "absolute",
        left: -400,
        right: -400,
        bottom: -60,
        height: 560,
        perspective: 700,
        maskImage: "linear-gradient(180deg, transparent 0%, black 60%)",
        WebkitMaskImage: "linear-gradient(180deg, transparent 0%, black 60%)",
        opacity: 0.55,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: "rotateX(62deg)",
          transformOrigin: "50% 100%",
          backgroundImage:
            "linear-gradient(rgba(21,132,196,0.22) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(21,132,196,0.22) 1.5px, transparent 1.5px)",
          backgroundSize: "80px 80px",
          backgroundPosition: `0px ${scroll}px`,
        }}
      />
    </div>
  );
};

// A glossy soap bubble: a clear sphere with a rim, a highlight and a little iridescence.
export const AeroBubble: React.FC<{ seed: string }> = ({ seed }) => {
  const frame = useCurrentFrame();
  const size = 40 + random(`${seed}-s`) * 110;
  const x = random(`${seed}-x`) * 1920;
  const speed = 0.5 + random(`${seed}-v`) * 0.9;
  const span = 1080 + size * 2;
  const y = 1080 + size - ((frame * speed + random(`${seed}-o`) * span) % span);
  const sway =
    Math.sin(frame / (30 + random(`${seed}-w`) * 30) + random(seed) * 6) * 24;
  return (
    <div
      style={{
        position: "absolute",
        left: x + sway,
        top: y,
        width: size,
        height: size,
        borderRadius: "50%",
        background:
          "radial-gradient(circle at 32% 28%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.35) 14%, rgba(255,255,255,0) 30%), radial-gradient(circle at 50% 50%, rgba(255,255,255,0) 58%, rgba(140,210,245,0.35) 78%, rgba(190,160,255,0.35) 90%, rgba(255,255,255,0.75) 100%)",
        boxShadow: "inset 0 -6px 14px rgba(92,196,244,0.25)",
        opacity: interpolate(size, [40, 150], [0.75, 0.45]),
      }}
    />
  );
};

// Four-point Y2K sparkle that twinkles.
export const Sparkle: React.FC<{
  x: number;
  y: number;
  size?: number;
  delay?: number;
  color?: string;
}> = ({ x, y, size = 36, delay = 0, color = "#ffffff" }) => {
  const frame = useCurrentFrame();
  const t = frame - delay;
  const s = t < 0 ? 0 : 0.55 + 0.45 * Math.abs(Math.sin(t / 14));
  const appear = interpolate(t, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      style={{
        position: "absolute",
        left: x - size / 2,
        top: y - size / 2,
        scale: String(s * appear),
        rotate: `${t * 0.8}deg`,
        filter: "drop-shadow(0 0 8px rgba(92,196,244,0.9))",
      }}
    >
      <path
        d="M50 0 C54 36 64 46 100 50 C64 54 54 64 50 100 C46 64 36 54 0 50 C36 46 46 36 50 0Z"
        fill={color}
      />
    </svg>
  );
};
