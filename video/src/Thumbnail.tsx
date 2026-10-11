import React from "react";
import { AbsoluteFill } from "remotion";
import { Backdrop, Sparkle } from "./components/Backdrop";
import { AtlasOrb } from "./components/Logo";
import { accentText, C, sans } from "./theme";

// 3:2 thumbnail: the wordmark and a tagline on the launch video's sky.
// npx remotion still Thumbnail out/atlas-thumbnail.png --frame=60
export const THUMB = { width: 2400, height: 1600, frames: 90 };

export const Thumbnail: React.FC = () => (
  <AbsoluteFill>
    <Backdrop seed="thumb" bubbles={12} />
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        fontFamily: sans,
        color: C.text,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 56,
          marginTop: 10,
        }}
      >
        <AtlasOrb
          size={330}
          spin={24}
          style={{ filter: "drop-shadow(0 30px 50px rgba(21,132,196,0.35))" }}
        />
        <div
          style={{
            fontSize: 380,
            fontWeight: 900,
            letterSpacing: "-0.055em",
            lineHeight: 1,
            paddingBottom: 30,
          }}
        >
          atlas<span style={accentText}>.</span>
        </div>
      </div>
      <div
        style={{
          marginTop: 40,
          fontSize: 96,
          fontWeight: 800,
          letterSpacing: "-0.035em",
        }}
      >
        The friend who <span style={accentText}>actually plans the trip.</span>
      </div>
    </AbsoluteFill>
    <Sparkle x={560} y={360} size={80} delay={-40} />
    <Sparkle x={1930} y={330} size={60} delay={-25} />
    <Sparkle x={2090} y={1240} size={46} delay={-10} />
    <Sparkle x={420} y={1150} size={54} delay={-55} />
  </AbsoluteFill>
);
