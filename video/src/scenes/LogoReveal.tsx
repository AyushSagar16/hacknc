import React from "react";
import { Audio } from "@remotion/media";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Backdrop, Sparkle } from "../components/Backdrop";
import { AtlasOrb } from "../components/Logo";
import { Sub } from "../components/Text";
import { accentText, C, clamp, sans } from "../theme";

// The drop: the glossy globe lands, the wordmark writes itself, a lens flare sweeps through.
export const LogoReveal: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const orb = interpolate(frame, [0, 22], [0, 1], {
    ...clamp,
    easing: Easing.spring({ damping: 10, mass: 0.9 }),
  });
  const slide = interpolate(frame, [18, 40], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const flare = interpolate(frame, [26, 62], [-0.3, 1.3], clamp);
  const ring = interpolate(frame, [0, 40], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const letters = "Atlas".split("");
  return (
    <AbsoluteFill>
      <Backdrop seed="logo" bubbles={9} />
      {/* shockwave ring */}
      <div
        style={{
          position: "absolute",
          left: 960 - 600,
          top: 470 - 600,
          width: 1200,
          height: 1200,
          borderRadius: "50%",
          border: `3px solid ${C.accentLight}`,
          scale: String(ring),
          opacity: 0.6 * (1 - ring),
        }}
      />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 40,
            translate: `${(1 - slide) * 170}px -40px`,
          }}
        >
          <div
            style={{
              scale: String(orb),
              rotate: `${(1 - orb) * -90}deg`,
              filter: "drop-shadow(0 24px 40px rgba(21,132,196,0.35))",
            }}
          >
            <AtlasOrb size={250} spin={frame * 1.6} />
          </div>
          <div
            style={{
              display: "flex",
              fontFamily: sans,
              fontWeight: 900,
              fontSize: 260,
              letterSpacing: "-0.05em",
              lineHeight: 1,
            }}
          >
            {letters.map((l, i) => {
              const p = interpolate(frame, [22 + i * 4, 40 + i * 4], [0, 1], {
                ...clamp,
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              });
              return (
                <span
                  key={i}
                  style={{
                    display: "inline-block",
                    opacity: p,
                    translate: `0px ${(1 - p) * 90}px`,
                    filter: `blur(${(1 - p) * 14}px)`,
                    color: C.text,
                    paddingBottom: 20,
                  }}
                >
                  {l}
                </span>
              );
            })}
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            top: 640,
            width: "100%",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: sans,
              fontWeight: 800,
              fontSize: 64,
              letterSpacing: "-0.03em",
              color: C.text,
              opacity: interpolate(frame, [52, 70], [0, 1], clamp),
              translate: `0px ${interpolate(frame, [52, 72], [30, 0], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) })}px`,
            }}
          >
            The friend who{" "}
            <span style={accentText}>actually plans the trip.</span>
          </div>
          <Sub at={78} size={38} style={{ marginTop: 18 }}>
            An AI trip &amp; money planner that lives in your iMessage group
            chat.
          </Sub>
        </div>
      </AbsoluteFill>
      {/* lens flare sweep */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${flare * 100}%`,
          width: 260,
          marginLeft: -130,
          background:
            "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0) 100%)",
          rotate: "14deg",
          mixBlendMode: "screen",
          opacity: flare > 0 && flare < 1.2 ? 0.9 : 0,
        }}
      />
      <Sparkle x={560} y={330} size={54} delay={20} />
      <Sparkle x={1500} y={360} size={40} delay={30} />
      <Sparkle x={1420} y={600} size={30} delay={38} />
      <Sparkle x={470} y={620} size={34} delay={44} />
      <Sequence name="sfx sparkle" durationInFrames={2 * fps} premountFor={fps}>
        <Audio src={staticFile("audio/sparkle.wav")} volume={0.45} />
      </Sequence>
    </AbsoluteFill>
  );
};
