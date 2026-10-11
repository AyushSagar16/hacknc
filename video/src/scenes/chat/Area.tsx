import React from "react";
import { AbsoluteFill } from "remotion";
import { sans } from "../../theme";

// The phone sits 120px from one edge; chapter content fills the other side.
export const PHONE_SCALE = 1.12;
export const PHONE_X = { left: 120, right: 1329 } as const;

export const Area: React.FC<{
  side: "left" | "right";
  children: React.ReactNode;
}> = ({ side, children }) => (
  <AbsoluteFill style={{ fontFamily: sans }}>
    <div
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: side === "left" ? 110 : 690,
        width: 1130,
      }}
    >
      {children}
    </div>
  </AbsoluteFill>
);

// A small "C1" tile, as on the consent screen.
export const CapitalOneTile: React.FC<{ size?: number }> = ({ size = 30 }) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: size * 0.28,
      background: "#d22e1e",
      color: "#fff",
      fontWeight: 900,
      fontStyle: "italic",
      fontSize: size * 0.42,
      display: "inline-grid",
      placeItems: "center",
      letterSpacing: 0,
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4)",
    }}
  >
    C1
  </span>
);
