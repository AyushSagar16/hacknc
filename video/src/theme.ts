// The trip site's look (web/app/globals.css): Frutiger Aero kept quiet. A pale sky, frosted glass
// and one aqua accent; green only marks what the group chose.
import { loadFont as loadNunito } from "@remotion/google-fonts/NunitoSans";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { Easing } from "remotion";

export const { fontFamily: sans } = loadNunito("normal", {
  weights: ["400", "600", "700", "800", "900"],
  subsets: ["latin"],
});

export const { fontFamily: mono } = loadMono("normal", {
  weights: ["400", "600"],
  subsets: ["latin"],
});

// The phone renders in the platform font, like iOS does.
export const ios = `-apple-system, "SF Pro Text", BlinkMacSystemFont, system-ui, ${sans}, sans-serif`;

export const C = {
  skyTop: "#d7ecf8",
  skyBottom: "#f6fafd",
  orbA: "rgba(120, 200, 240, 0.45)",
  orbB: "rgba(150, 225, 205, 0.35)",
  glass: "rgba(255, 255, 255, 0.62)",
  glassStrong: "rgba(255, 255, 255, 0.84)",
  glassEdge: "rgba(255, 255, 255, 0.95)",
  text: "#0f2b3c",
  muted: "#5a7486",
  rule: "rgba(15, 43, 60, 0.1)",
  accent: "#1584c4",
  accentLight: "#5cc4f4",
  accentSoft: "rgba(21, 132, 196, 0.1)",
  chosen: "#2f9e6a",
  track: "rgba(15, 43, 60, 0.08)",
  // Capital One (the consent screen in web/app/connect)
  navy: "#004977",
  navyDeep: "#013250",
  red: "#d22e1e",
  // iMessage
  blue: "#0a7cff",
  blueTop: "#3a9bff",
  gray: "#e9e9eb",
};

export const shadow =
  "0 1px 2px rgba(14, 60, 90, 0.06), 0 18px 50px rgba(14, 60, 90, 0.12)";

export const glassPanel: React.CSSProperties = {
  background: C.glass,
  border: `1.5px solid ${C.glassEdge}`,
  borderRadius: 28,
  boxShadow: `${shadow}, inset 0 1.5px 0 ${C.glassEdge}`,
  backdropFilter: "blur(24px) saturate(1.4)",
  WebkitBackdropFilter: "blur(24px) saturate(1.4)",
};

export const accentText: React.CSSProperties = {
  backgroundImage: `linear-gradient(180deg, ${C.accentLight} 0%, ${C.accent} 70%, #0f6aa0 100%)`,
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

export const ease = Easing.bezier(0.16, 1, 0.3, 1);
export const spring200 = Easing.spring({ damping: 200 });
export const bouncy = Easing.spring({ damping: 14, mass: 0.8 });

export const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;
