import React from "react";
import { Audio } from "@remotion/media";
import {
  Easing,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { AtlasOrb } from "../components/Logo";
import { C, clamp, ios } from "../theme";

// The bank-connect consent page (web/app/connect/[token]) opened from the link, in a sheet.
export const ConsentSheet: React.FC<{
  open: number;
  tap: number;
  close: number;
}> = ({ open, tap, close }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < open - 2 || frame > close + 24) return null;
  const up = interpolate(frame, [open, open + 18], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.2, 0.9, 0.2, 1),
  });
  const down = interpolate(frame, [close, close + 18], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.5, 0, 0.8, 0.4),
  });
  const y = (1 - up + down) * 860;
  const pressed = frame >= tap && frame < tap + 6;
  const done = frame >= tap + 8;
  const touch = interpolate(
    frame,
    [tap - 14, tap - 4, tap, tap + 8],
    [0, 1, 1, 0],
    clamp,
  );
  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.25)",
          opacity: up * (1 - down),
          zIndex: 34,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 52,
          bottom: 0,
          translate: `0px ${y}px`,
          borderRadius: "14px 14px 0 0",
          overflow: "hidden",
          background: "#f3f6f8",
          zIndex: 35,
          fontFamily: ios,
          color: "#1b1f23",
        }}
      >
        <div
          style={{
            background: C.navy,
            color: "#fff",
            padding: "14px 16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontWeight: 700,
              fontStyle: "italic",
              fontSize: 19,
              letterSpacing: -0.2,
            }}
          >
            Capital One
          </span>
          <span
            style={{
              fontSize: 13,
              opacity: 0.9,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <svg width="10" height="12" viewBox="0 0 10 12">
              <rect x="0.5" y="5" width="9" height="6.5" rx="1.5" fill="#fff" />
              <path
                d="M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5"
                stroke="#fff"
                strokeWidth="1.4"
                fill="none"
              />
            </svg>
            Secure
          </span>
        </div>
        <div style={{ padding: "16px 14px" }}>
          <div
            style={{
              background: "#fff",
              borderRadius: 16,
              border: "1px solid #e3e8ec",
              padding: "20px 16px 16px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                gap: 10,
                marginBottom: 14,
              }}
            >
              <AtlasOrb size={44} />
              <div style={{ display: "flex", gap: 4 }}>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: "#9fb0bd",
                      opacity:
                        0.4 + 0.6 * Math.max(0, Math.sin((frame - i * 4) / 5)),
                    }}
                  />
                ))}
              </div>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 13,
                  background: C.red,
                  color: "#fff",
                  fontWeight: 800,
                  display: "grid",
                  placeItems: "center",
                  fontSize: 16,
                  fontStyle: "italic",
                }}
              >
                C1
              </div>
            </div>
            <div
              style={{
                fontSize: 21,
                fontWeight: 700,
                textAlign: "center",
                lineHeight: 1.2,
                letterSpacing: -0.3,
              }}
            >
              Atlas wants to connect to your Capital One accounts
            </div>
            <div
              style={{
                textAlign: "center",
                fontSize: 14,
                color: "#5b6670",
                marginTop: 6,
              }}
            >
              Connecting as <b style={{ color: "#1b1f23" }}>Maya</b> to Atlas
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: "-0.01em",
                color: "#5b6670",
                margin: "16px 0 6px",
              }}
            >
              Atlas will be able to see
            </div>
            {[
              ["$", "Account balances", "Checking and savings"],
              [
                "≡",
                "Transactions",
                "The last 3 months, to suggest a trip budget you can afford",
              ],
            ].map(([icon, title, sub]) => (
              <div
                key={title}
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "8px 0",
                  borderTop: "1px solid #e3e8ec",
                }}
              >
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 9,
                    background: "#e8f0f6",
                    color: C.navy,
                    display: "grid",
                    placeItems: "center",
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {icon}
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.3 }}>
                  <b>{title}</b>
                  <div style={{ color: "#5b6670" }}>{sub}</div>
                </div>
              </div>
            ))}
            <div
              style={{
                background: "#f3f6f8",
                borderRadius: 12,
                padding: "10px 12px",
                fontSize: 13,
                lineHeight: 1.35,
                color: "#3c4750",
                marginTop: 8,
              }}
            >
              <b>You stay in control.</b> Atlas only moves money for trip-fund
              contributions and settle-ups you confirm in the chat.
              <div style={{ marginTop: 6 }}>
                <b>Private.</b> Your group only ever sees pooled numbers.
              </div>
            </div>
            <div
              style={{
                position: "relative",
                marginTop: 14,
                borderRadius: 12,
                padding: "13px 0",
                textAlign: "center",
                fontWeight: 700,
                fontSize: 17,
                color: "#fff",
                background: done ? C.chosen : pressed ? "#a51f13" : C.red,
                scale: pressed ? "0.97" : "1",
              }}
            >
              {done ? "Connected ✓" : "Connect"}
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: 46,
                  height: 46,
                  marginLeft: -23,
                  marginTop: -23,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.45)",
                  border: "2px solid rgba(255,255,255,0.9)",
                  opacity: touch,
                  scale: String(interpolate(touch, [0, 1], [1.6, 1])),
                }}
              />
            </div>
          </div>
        </div>
      </div>
      <Sequence
        from={tap}
        durationInFrames={fps}
        name="sfx tap"
        premountFor={fps}
      >
        <Audio src={staticFile("audio/tap.wav")} volume={0.6} />
      </Sequence>
    </>
  );
};
