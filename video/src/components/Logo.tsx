import React from "react";

// Atlas's mark: a glossy aqua globe, Y2K style. Also used as Atlas's avatar in the chat.
export const AtlasOrb: React.FC<{
  size: number;
  spin?: number;
  style?: React.CSSProperties;
}> = ({ size, spin = 0, style }) => {
  const id = React.useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={style}>
      <defs>
        <radialGradient id={`body-${id}`} cx="38%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#bff0ff" />
          <stop offset="35%" stopColor="#5cc4f4" />
          <stop offset="75%" stopColor="#1584c4" />
          <stop offset="100%" stopColor="#0b5d8f" />
        </radialGradient>
        <linearGradient id={`gloss-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`glow-${id}`} cx="50%" cy="85%" r="45%">
          <stop offset="0%" stopColor="#c8f7ff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#c8f7ff" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`clip-${id}`}>
          <circle cx="50" cy="50" r="46" />
        </clipPath>
      </defs>
      <circle cx="50" cy="52" r="46" fill="#0b5d8f" opacity="0.18" />
      <circle cx="50" cy="50" r="46" fill={`url(#body-${id})`} />
      <g
        clipPath={`url(#clip-${id})`}
        stroke="#ffffff"
        strokeOpacity="0.55"
        strokeWidth="1.6"
        fill="none"
      >
        {[0, 1, 2, 3].map((k) => {
          // A meridian at longitude λ projects to an ellipse with rx = R·|sin λ|.
          const lambda = ((k * 45 + spin) * Math.PI) / 180;
          return (
            <ellipse
              key={k}
              cx={50}
              cy={50}
              rx={Math.max(0.5, 46 * Math.abs(Math.sin(lambda)))}
              ry={46}
            />
          );
        })}
        <ellipse cx="50" cy="50" rx="46" ry="16" />
        <line x1="4" y1="50" x2="96" y2="50" />
        <ellipse cx="50" cy="30" rx="38" ry="9" opacity="0.6" />
        <ellipse cx="50" cy="70" rx="38" ry="9" opacity="0.6" />
      </g>
      <circle cx="50" cy="50" r="46" fill={`url(#glow-${id})`} />
      <ellipse cx="50" cy="27" rx="33" ry="19" fill={`url(#gloss-${id})`} />
      <circle
        cx="50"
        cy="50"
        r="45.2"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.7"
        strokeWidth="1.4"
      />
    </svg>
  );
};
