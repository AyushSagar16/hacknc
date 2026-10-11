import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { Backdrop, Sparkle } from "../components/Backdrop";
import { AtlasOrb } from "../components/Logo";
import { Headline } from "../components/Text";
import { C, clamp, glassPanel, sans } from "../theme";

const STACK = [
  "Photon Spectrum",
  "Linq",
  "Capital One Nessie",
  "Gemini",
  "Tiger Data",
];

export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const orb = interpolate(frame, [0, 24], [0, 1], {
    ...clamp,
    easing: Easing.spring({ damping: 11 }),
  });
  const cta = interpolate(frame, [44, 62], [0, 1], {
    ...clamp,
    easing: Easing.spring({ damping: 13 }),
  });
  const fadeOut = interpolate(frame, [150, 178], [0, 1], clamp);
  return (
    <AbsoluteFill>
      <Backdrop seed="end" bubbles={10} />
      <AbsoluteFill style={{ alignItems: "center", fontFamily: sans }}>
        <div
          style={{
            marginTop: 120,
            display: "flex",
            alignItems: "center",
            gap: 28,
          }}
        >
          <div
            style={{
              scale: String(orb),
              filter: "drop-shadow(0 20px 36px rgba(21,132,196,0.35))",
            }}
          >
            <AtlasOrb size={150} spin={frame * 1.4} />
          </div>
          <div
            style={{
              fontWeight: 900,
              fontSize: 150,
              letterSpacing: "-0.05em",
              color: C.text,
              opacity: interpolate(frame, [8, 22], [0, 1], clamp),
              translate: `${interpolate(frame, [8, 28], [-30, 0], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) })}px 0px`,
            }}
          >
            Atlas
          </div>
        </div>
        <Headline
          at={20}
          size={90}
          align="center"
          text={"Plan the trip. Split the bill.\n*Stay friends.*"}
          style={{ marginTop: 44 }}
        />
        <div
          style={{
            ...glassPanel,
            marginTop: 52,
            borderRadius: 999,
            padding: "22px 46px 22px 30px",
            display: "flex",
            alignItems: "center",
            gap: 18,
            fontSize: 38,
            fontWeight: 800,
            color: C.text,
            opacity: cta,
            scale: String(interpolate(cta, [0, 1], [0.8, 1])),
          }}
        >
          <span
            style={{
              width: 54,
              height: 54,
              borderRadius: 16,
              background: "linear-gradient(180deg, #5df27a, #23c244)",
              display: "grid",
              placeItems: "center",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.6)",
            }}
          >
            <svg width="30" height="28" viewBox="0 0 30 28">
              <path
                d="M15 2C7.8 2 2 6.9 2 13c0 3.4 1.8 6.4 4.7 8.4-.3 1.9-1.3 3.6-2.7 4.6 2.8 0 5.2-1 6.9-2.6 1.3.4 2.7.6 4.1.6 7.2 0 13-4.9 13-11S22.2 2 15 2z"
                fill="#fff"
              />
            </svg>
          </span>
          Add Atlas to your group chat
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 70,
            display: "flex",
            gap: 14,
            alignItems: "center",
            fontSize: 24,
            fontWeight: 700,
            color: C.muted,
            opacity: interpolate(frame, [70, 86], [0, 1], clamp),
          }}
        >
          <span
            style={{
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              fontSize: 19,
              fontWeight: 800,
              marginRight: 6,
            }}
          >
            Built on
          </span>
          {STACK.map((s, i) => (
            <React.Fragment key={s}>
              {i ? <span style={{ opacity: 0.4 }}>·</span> : null}
              <span>{s}</span>
            </React.Fragment>
          ))}
        </div>
      </AbsoluteFill>
      <Sparkle x={420} y={210} size={50} delay={14} />
      <Sparkle x={1530} y={250} size={38} delay={22} />
      <Sparkle x={1620} y={640} size={30} delay={30} />
      <Sparkle x={300} y={700} size={34} delay={36} />
      <AbsoluteFill style={{ background: C.skyBottom, opacity: fadeOut }} />
    </AbsoluteFill>
  );
};
