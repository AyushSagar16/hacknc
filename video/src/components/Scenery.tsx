import React from "react";

// Small flat illustrations for destination cards, in the site's sky palette.
export type Place = "charleston" | "savannah" | "wilmington" | "cancun";

export const Scenery: React.FC<{
  place: Place;
  width?: number | string;
  height: number;
}> = ({ place, width = "100%", height }) => {
  const id = `sc-${place}`;
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 360 200"
      preserveAspectRatio="xMidYMid slice"
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0%"
            stopColor={place === "cancun" ? "#7fd6e8" : "#8fd3f4"}
          />
          <stop offset="65%" stopColor="#d7ecf8" />
          <stop
            offset="100%"
            stopColor={place === "savannah" ? "#e6f3dc" : "#ffe9cc"}
          />
        </linearGradient>
        <linearGradient id={`${id}-sea`} x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0%"
            stopColor={place === "cancun" ? "#2cc4c9" : "#3aa0d8"}
          />
          <stop
            offset="100%"
            stopColor={place === "cancun" ? "#138f9e" : "#1a6fa3"}
          />
        </linearGradient>
        <linearGradient id={`${id}-gloss`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="360" height="200" fill={`url(#${id}-sky)`} />
      <circle cx="290" cy="64" r="24" fill="#fff6d8" />
      {place === "charleston" ? (
        <>
          {[
            ["#f7c9c1", 18, 70],
            ["#bfe3d0", 64, 60],
            ["#fbe3a6", 110, 76],
            ["#c9d8f3", 156, 64],
            ["#f5d0e3", 202, 72],
            ["#d9ecc4", 248, 58],
          ].map(([fill, x, h]) => (
            <g key={String(x)}>
              <rect
                x={Number(x)}
                y={150 - Number(h)}
                width="42"
                height={Number(h)}
                fill={String(fill)}
              />
              <path
                d={`M${Number(x) - 3} ${150 - Number(h)} L${Number(x) + 21} ${135 - Number(h)} L${Number(x) + 45} ${150 - Number(h)}Z`}
                fill="#fff"
                opacity="0.9"
              />
              <rect
                x={Number(x) + 8}
                y={158 - Number(h)}
                width="9"
                height="13"
                fill="#fff"
                opacity="0.85"
              />
              <rect
                x={Number(x) + 25}
                y={158 - Number(h)}
                width="9"
                height="13"
                fill="#fff"
                opacity="0.85"
              />
            </g>
          ))}
          <rect y="150" width="360" height="50" fill={`url(#${id}-sea)`} />
        </>
      ) : null}
      {place === "savannah" ? (
        <>
          <rect y="150" width="360" height="50" fill="#9ccf8a" />
          {[50, 170, 290].map((x) => (
            <g key={x}>
              <rect x={x - 5} y="105" width="10" height="50" fill="#7a5a44" />
              <ellipse cx={x} cy="100" rx="58" ry="34" fill="#5fae6e" />
              <ellipse cx={x - 16} cy="92" rx="30" ry="20" fill="#7cc487" />
              {[-30, -10, 12, 32].map((d) => (
                <path
                  key={d}
                  d={`M${x + d} 112 q 3 18 -2 30`}
                  stroke="#b9c9b0"
                  strokeWidth="3"
                  fill="none"
                />
              ))}
            </g>
          ))}
        </>
      ) : null}
      {place === "wilmington" ? (
        <>
          <rect y="130" width="360" height="40" fill={`url(#${id}-sea)`} />
          <rect y="165" width="360" height="35" fill="#f3dcae" />
          <rect x="40" y="122" width="210" height="8" fill="#a07a5c" />
          {[50, 90, 130, 170, 210, 240].map((x) => (
            <rect key={x} x={x} y="128" width="5" height="34" fill="#8a654a" />
          ))}
          <path d="M290 166 l18 -46 l18 46z" fill="#f18a7b" />
          <rect x="306" y="166" width="4" height="22" fill="#8a654a" />
        </>
      ) : null}
      {place === "cancun" ? (
        <>
          <rect y="135" width="360" height="40" fill={`url(#${id}-sea)`} />
          <rect y="170" width="360" height="30" fill="#f8e7c4" />
          <path
            d="M70 172 q 6 -50 -6 -84"
            stroke="#8a654a"
            strokeWidth="6"
            fill="none"
          />
          {[-60, -20, 20, 60, 110].map((a) => (
            <ellipse
              key={a}
              cx="64"
              cy="88"
              rx="30"
              ry="8"
              fill="#4fae6a"
              transform={`rotate(${a} 64 88) translate(22 0)`}
            />
          ))}
        </>
      ) : null}
      <rect width="360" height="80" fill={`url(#${id}-gloss)`} />
    </svg>
  );
};
