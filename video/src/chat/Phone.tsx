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
import { LinkPreview, SITE } from "../components/Photo";
import { C, clamp, ios } from "../theme";
import { ME, Msg, NAMES, Who } from "./types";

// An iPhone running Messages, drawn in points (393 × 852) like the real screen.
export const SCREEN_W = 393;
export const SCREEN_H = 852;
const BEZEL = 13;
export const PHONE_W = SCREEN_W + BEZEL * 2;
export const PHONE_H = SCREEN_H + BEZEL * 2;

const GROW = 9; // frames for a new row to open up

type Props = {
  messages: Msg[];
  groupName?: string;
  // Anything drawn over the chat (a sheet, a Safari view).
  overlay?: React.ReactNode;
  sounds?: boolean;
  style?: React.CSSProperties;
};

export const Phone: React.FC<Props> = ({
  messages,
  groupName = "beach trip?? 🌴",
  overlay,
  sounds = true,
  style,
}) => {
  return (
    <div
      style={{
        position: "absolute",
        width: PHONE_W,
        height: PHONE_H,
        borderRadius: 68,
        padding: BEZEL,
        background:
          "linear-gradient(145deg, #f4f6f8 0%, #b9c0c7 30%, #8d959d 55%, #d9dee2 80%, #9aa2a9 100%)",
        boxShadow:
          "0 2px 0 rgba(255,255,255,0.8) inset, 0 40px 80px rgba(14, 60, 90, 0.28), 0 12px 24px rgba(14, 60, 90, 0.16)",
        ...style,
      }}
    >
      {/* side buttons */}
      <div
        style={{
          position: "absolute",
          left: -3,
          top: 190,
          width: 4,
          height: 34,
          borderRadius: 2,
          background: "#9aa2a9",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: -3,
          top: 250,
          width: 4,
          height: 62,
          borderRadius: 2,
          background: "#9aa2a9",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: -3,
          top: 324,
          width: 4,
          height: 62,
          borderRadius: 2,
          background: "#9aa2a9",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: -3,
          top: 270,
          width: 4,
          height: 96,
          borderRadius: 2,
          background: "#9aa2a9",
        }}
      />
      <div
        style={{
          position: "relative",
          width: SCREEN_W,
          height: SCREEN_H,
          borderRadius: 56,
          overflow: "hidden",
          background: "#000",
          padding: 3,
        }}
      >
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            borderRadius: 53,
            overflow: "hidden",
            background: "#ffffff",
            fontFamily: ios,
            color: "#000",
          }}
        >
          <Thread messages={messages} />
          <Header groupName={groupName} />
          <InputBar messages={messages} />
          {overlay}
          <StatusBar dark={false} />
          <div
            style={{
              position: "absolute",
              top: 11,
              left: "50%",
              marginLeft: -62,
              width: 124,
              height: 36,
              borderRadius: 20,
              background: "#000",
              zIndex: 50,
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: 8,
              left: "50%",
              marginLeft: -68,
              width: 136,
              height: 5,
              borderRadius: 3,
              background: "#000",
              zIndex: 50,
            }}
          />
        </div>
      </div>
      {sounds ? <MessageSounds messages={messages} /> : null}
    </div>
  );
};

const MessageSounds: React.FC<{ messages: Msg[] }> = ({ messages }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {messages.map((m, i) =>
        m.kind === "system" ? null : (
          <Sequence
            key={i}
            from={m.at}
            durationInFrames={fps}
            name={`sfx ${m.kind}`}
            premountFor={fps}
          >
            <Audio
              src={staticFile(
                m.from === ME ? "audio/send.wav" : "audio/receive.wav",
              )}
              volume={m.from === ME ? 0.5 : 0.55}
            />
          </Sequence>
        ),
      )}
    </>
  );
};

export const StatusBar: React.FC<{ dark?: boolean }> = ({ dark }) => {
  const ink = dark ? "#fff" : "#000";
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 54,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "6px 34px 0 46px",
        zIndex: 40,
        color: ink,
        fontFamily: ios,
      }}
    >
      <span style={{ fontWeight: 600, fontSize: 17, letterSpacing: -0.2 }}>
        9:41
      </span>
      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <svg width="19" height="12" viewBox="0 0 19 12">
          {[0, 1, 2, 3].map((i) => (
            <rect
              key={i}
              x={i * 5}
              y={9 - i * 3}
              width="3.2"
              height={3 + i * 3}
              rx="1"
              fill={ink}
            />
          ))}
        </svg>
        <svg width="17" height="12" viewBox="0 0 17 12" fill={ink}>
          <path d="M8.5 2.2c2.4 0 4.6.9 6.2 2.5l1.2-1.2C13.9 1.5 11.3.4 8.5.4S3.1 1.5 1.1 3.5l1.2 1.2C3.9 3.1 6.1 2.2 8.5 2.2z" />
          <path d="M8.5 5.6c1.5 0 2.8.6 3.8 1.5l1.2-1.2C12.2 4.6 10.4 3.8 8.5 3.8S4.8 4.6 3.5 5.9l1.2 1.2c1-.9 2.3-1.5 3.8-1.5z" />
          <path d="M8.5 9c.6 0 1.1.2 1.5.6L8.5 11.2 7 9.6c.4-.4.9-.6 1.5-.6z" />
        </svg>
        <svg width="28" height="13" viewBox="0 0 28 13">
          <rect
            x="0.5"
            y="0.5"
            width="24"
            height="12"
            rx="3.8"
            fill="none"
            stroke={ink}
            strokeOpacity="0.4"
          />
          <rect x="2" y="2" width="19" height="9" rx="2.4" fill={ink} />
          <path
            d="M26 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z"
            fill={ink}
            fillOpacity="0.45"
          />
        </svg>
      </span>
    </div>
  );
};

const Avatar: React.FC<{
  who: Who;
  size: number;
  style?: React.CSSProperties;
}> = ({ who, size, style }) => {
  if (who === "atlas") return <AtlasOrb size={size} style={style} />;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "linear-gradient(180deg, #a6abb8 0%, #858a96 100%)",
        color: "#fff",
        display: "grid",
        placeItems: "center",
        fontWeight: 600,
        fontSize: size * 0.42,
        letterSpacing: -0.3,
        flexShrink: 0,
        ...style,
      }}
    >
      {NAMES[who][0]}
    </div>
  );
};

const Header: React.FC<{ groupName: string }> = ({ groupName }) => (
  <div
    style={{
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 140,
      paddingTop: 58,
      background: "rgba(248,248,250,0.88)",
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      borderBottom: "0.5px solid rgba(0,0,0,0.12)",
      zIndex: 30,
    }}
  >
    <div
      style={{
        position: "absolute",
        left: 14,
        top: 70,
        display: "flex",
        alignItems: "center",
        gap: 2,
        color: C.blue,
      }}
    >
      <svg width="13" height="21" viewBox="0 0 13 21">
        <path
          d="M11 2 2.5 10.5 11 19"
          stroke={C.blue}
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span
        style={{
          background: C.blue,
          color: "#fff",
          borderRadius: 11,
          fontSize: 14,
          fontWeight: 600,
          padding: "1px 7px",
          marginLeft: 4,
        }}
      >
        3
      </span>
    </div>
    <svg
      width="28"
      height="20"
      viewBox="0 0 28 20"
      style={{ position: "absolute", right: 18, top: 72 }}
    >
      <rect
        x="1"
        y="3"
        width="18"
        height="14"
        rx="4"
        fill="none"
        stroke={C.blue}
        strokeWidth="2"
      />
      <path d="M20 8.5 27 4v12l-7-4.5z" fill={C.blue} />
    </svg>
    <div style={{ display: "flex", justifyContent: "center", marginTop: 0 }}>
      {(["leo", "atlas", "priya"] as Who[]).map((w, i) => (
        <Avatar
          key={w}
          who={w}
          size={i === 1 ? 46 : 38}
          style={{
            marginLeft: i ? -10 : 0,
            marginTop: i === 1 ? 0 : 6,
            border: "2px solid #f8f8fa",
            borderRadius: "50%",
            zIndex: i === 1 ? 2 : 1,
            boxSizing: "content-box",
          }}
        />
      ))}
    </div>
    <div
      style={{
        textAlign: "center",
        fontSize: 12.5,
        marginTop: 3,
        color: "#000",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 3,
      }}
    >
      {groupName}
      <svg width="6" height="10" viewBox="0 0 6 10">
        <path
          d="M1 1l4 4-4 4"
          stroke="#8e8e93"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    </div>
  </div>
);

// Maya's outgoing message is typed into the field first, then sent.
const InputBar: React.FC<{ messages: Msg[] }> = ({ messages }) => {
  const frame = useCurrentFrame();
  const typing = messages.find(
    (m): m is Extract<Msg, { kind: "text" }> =>
      m.kind === "text" &&
      m.from === ME &&
      frame >= m.at - (m.typing ?? 18) &&
      frame < m.at,
  );
  let text = "";
  if (typing) {
    const dur = typing.typing ?? 18;
    const p = interpolate(
      frame,
      [typing.at - dur, typing.at - 4],
      [0, 1],
      clamp,
    );
    text = typing.text.slice(0, Math.round(typing.text.length * p));
  }
  const caret = Math.floor(frame / 8) % 2 === 0;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 92,
        padding: "10px 12px 0",
        display: "flex",
        alignItems: "flex-start",
        gap: 9,
        background: "rgba(255,255,255,0.92)",
        backdropFilter: "blur(20px)",
        zIndex: 30,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "#eeeef0",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16">
          <path
            d="M8 2v12M2 8h12"
            stroke="#7d7d82"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 36,
          borderRadius: 18,
          border: "1px solid #d4d4d8",
          display: "flex",
          alignItems: "center",
          padding: "6px 6px 6px 14px",
          fontSize: 17,
          color: text ? "#000" : "#a1a1a6",
          justifyContent: "space-between",
          gap: 6,
          overflow: "hidden",
        }}
      >
        <span
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "clip",
            direction: "rtl",
            textAlign: "left",
            flex: 1,
          }}
        >
          <bdi>
            {text || (typing ? "" : "iMessage")}
            {typing ? (
              <span
                style={{
                  display: "inline-block",
                  width: 2,
                  height: 20,
                  background: C.blue,
                  verticalAlign: -4,
                  marginLeft: 1,
                  opacity: caret ? 1 : 0,
                }}
              />
            ) : null}
          </bdi>
        </span>
        {text ? (
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: C.blue,
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            <svg width="14" height="16" viewBox="0 0 14 16">
              <path
                d="M7 14V2M2 7l5-5 5 5"
                stroke="#fff"
                strokeWidth="2.4"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        ) : (
          <svg
            width="14"
            height="20"
            viewBox="0 0 14 20"
            style={{ marginRight: 6 }}
          >
            <rect x="4" y="1" width="6" height="11" rx="3" fill="#a1a1a6" />
            <path
              d="M1.5 9a5.5 5.5 0 0 0 11 0M7 14.5V18"
              stroke="#a1a1a6"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        )}
      </div>
    </div>
  );
};

// One row that opens from zero height (CSS grid 0fr → 1fr), so the thread scrolls smoothly.
const Grow: React.FC<{ p: number; children: React.ReactNode }> = ({
  p,
  children,
}) => (
  <div
    style={{
      display: "grid",
      gridTemplateRows: `${Math.max(0, Math.min(1, p))}fr`,
    }}
  >
    <div style={{ minHeight: 0, overflow: "hidden" }}>{children}</div>
  </div>
);

const Thread: React.FC<{ messages: Msg[] }> = ({ messages }) => {
  const frame = useCurrentFrame();
  const visible = messages.filter(
    (m) =>
      frame >=
      m.at - (m.kind === "text" && m.from !== ME ? (m.typing ?? 0) : 0),
  );

  const rows: React.ReactNode[] = [];
  visible.forEach((m, i) => {
    const landed = frame >= m.at;
    const grow = interpolate(frame, [m.at, m.at + GROW], [0, 1], {
      ...clamp,
      easing: Easing.bezier(0.2, 0.8, 0.2, 1),
    });
    const prev = visible
      .slice(0, i)
      .reverse()
      .find((x) => frame >= x.at);
    const next = visible.slice(i + 1).find((x) => frame >= x.at);
    const from = m.kind === "system" ? null : m.from;
    const firstInRun = !prev || prev.kind === "system" || prev.from !== from;
    const lastInRun = !next || next.kind === "system" || next.from !== from;

    // Typing bubble before someone else's message.
    if (m.kind === "text" && m.from !== ME && m.typing) {
      const start = m.at - m.typing;
      const open = interpolate(frame, [start, start + 7], [0, 1], clamp);
      const close = interpolate(frame, [m.at, m.at + GROW], [1, 0], clamp);
      rows.push(
        <Grow key={`t${i}`} p={open * close}>
          <Row who={m.from} first={firstInRun} last showName={firstInRun}>
            <Typing />
          </Row>
        </Grow>,
      );
    }
    if (!landed) return;

    const pop = interpolate(frame, [m.at, m.at + 14], [0, 1], {
      ...clamp,
      easing: Easing.spring({ damping: 13, mass: 0.7 }),
    });
    const fade = interpolate(frame, [m.at, m.at + 5], [0, 1], clamp);
    const mine = from === ME;
    const bubbleStyle: React.CSSProperties = {
      opacity: fade,
      scale: String(interpolate(pop, [0, 1], [0.55, 1])),
      translate: `0px ${interpolate(pop, [0, 1], [mine ? 26 : 10, 0])}px`,
      transformOrigin: mine ? "100% 100%" : "0% 100%",
    };

    if (m.kind === "system") {
      rows.push(
        <Grow key={i} p={grow}>
          <div
            style={{
              textAlign: "center",
              fontSize: 12.5,
              color: "#8e8e93",
              padding: "10px 30px 6px",
              opacity: fade,
            }}
          >
            {m.text}
          </div>
        </Grow>,
      );
      return;
    }

    let content: React.ReactNode;
    if (m.kind === "text") {
      content = (
        <Bubble mine={mine} tail={lastInRun} react={m.react}>
          {m.text}
        </Bubble>
      );
    } else if (m.kind === "poll") {
      content = <Poll title={m.title} options={m.options} />;
    } else {
      content = <LinkCard title={m.title} art={m.art} caption={m.caption} />;
    }

    rows.push(
      <Grow key={i} p={grow}>
        <Row
          who={from!}
          first={firstInRun}
          last={lastInRun}
          showName={firstInRun && !mine}
        >
          <div style={bubbleStyle}>{content}</div>
        </Row>
      </Grow>,
    );
  });

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 140,
        bottom: 92,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        overflow: "hidden",
        paddingBottom: 8,
      }}
    >
      {rows}
    </div>
  );
};

const Row: React.FC<{
  who: Who;
  first: boolean;
  last: boolean;
  showName: boolean;
  children: React.ReactNode;
}> = ({ who, first, last, showName, children }) => {
  const mine = who === ME;
  return (
    <div
      style={{
        paddingTop: first ? 9 : 2,
        paddingLeft: mine ? 60 : 10,
        paddingRight: mine ? 12 : 48,
      }}
    >
      {showName ? (
        <div style={{ fontSize: 12, color: "#8e8e93", margin: "0 0 2px 50px" }}>
          {NAMES[who]}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: mine ? "flex-end" : "flex-start",
          gap: 8,
        }}
      >
        {mine ? null : (
          <div style={{ width: 32, flexShrink: 0 }}>
            {last ? <Avatar who={who} size={32} /> : null}
          </div>
        )}
        {children}
      </div>
    </div>
  );
};

const Bubble: React.FC<{
  mine: boolean;
  tail: boolean;
  react?: { emoji: string; at: number };
  children: React.ReactNode;
}> = ({ mine, tail, react, children }) => {
  const frame = useCurrentFrame();
  const bg = mine ? C.blue : C.gray;
  const reactPop = react
    ? interpolate(frame, [react.at, react.at + 12], [0, 1], {
        ...clamp,
        easing: Easing.spring({ damping: 10 }),
      })
    : 0;
  return (
    <div style={{ position: "relative", maxWidth: 282 }}>
      <div
        style={{
          position: "relative",
          zIndex: 1,
          background: mine
            ? `linear-gradient(180deg, ${C.blueTop} 0%, ${C.blue} 100%)`
            : bg,
          color: mine ? "#fff" : "#000",
          borderRadius: 19,
          padding: "8px 13px 9px",
          fontSize: 17.5,
          lineHeight: 1.3,
          letterSpacing: -0.25,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {children}
      </div>
      {tail ? (
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          style={{
            position: "absolute",
            bottom: 0,
            [mine ? "right" : "left"]: -6,
            transform: mine ? "none" : "scaleX(-1)",
            zIndex: 0,
          }}
        >
          <path
            d="M0 0 C1 12 6 18 20 20 C10 20 4 18 0 14 Z"
            fill={mine ? C.blue : bg}
            transform="translate(-4 0)"
          />
        </svg>
      ) : null}
      {react && frame >= react.at ? (
        <div
          style={{
            position: "absolute",
            top: -18,
            [mine ? "left" : "right"]: -14,
            zIndex: 2,
            width: 36,
            height: 30,
            borderRadius: 16,
            background: mine ? C.gray : C.blue,
            border: "2px solid #fff",
            display: "grid",
            placeItems: "center",
            fontSize: 16,
            scale: String(reactPop),
          }}
        >
          {react.emoji}
        </div>
      ) : null}
    </div>
  );
};

const Typing: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "relative",
        background: C.gray,
        borderRadius: 19,
        padding: "13px 15px",
        display: "flex",
        gap: 5,
      }}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: "#8e8e93",
            opacity: 0.4 + 0.6 * Math.max(0, Math.sin((frame - i * 5) / 4.5)),
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          left: -3,
          bottom: -1,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: C.gray,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: -8,
          bottom: -6,
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: C.gray,
        }}
      />
    </div>
  );
};

// A native iMessage poll.
const Poll: React.FC<{
  title: string;
  options: { label: string; votes: { who: Who; at: number }[] }[];
}> = ({ title, options }) => {
  const frame = useCurrentFrame();
  const counts = options.map(
    (o) => o.votes.filter((v) => frame >= v.at).length,
  );
  const total = Math.max(
    1,
    counts.reduce((a, b) => a + b, 0),
  );
  const lead = Math.max(...counts);
  return (
    <div
      style={{
        width: 286,
        background: "#f2f2f7",
        borderRadius: 20,
        padding: "12px 12px 10px",
        border: "1px solid #e1e1e6",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12.5,
          color: "#8e8e93",
          fontWeight: 600,
          letterSpacing: 0.2,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14">
          <rect
            x="1"
            y="1"
            width="12"
            height="12"
            rx="3"
            fill="none"
            stroke="#8e8e93"
            strokeWidth="1.5"
          />
          <path
            d="M4 9.5V7M7 9.5V4.5M10 9.5V6"
            stroke="#8e8e93"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        Poll
      </div>
      <div
        style={{
          fontSize: 17,
          fontWeight: 600,
          margin: "4px 2px 8px",
          letterSpacing: -0.3,
        }}
      >
        {title}
      </div>
      {options.map((o, i) => {
        const n = counts[i];
        const w = interpolate(n / total, [0, 1], [0, 100]);
        const won =
          n > 0 && n === lead && counts.filter((c) => c === lead).length === 1;
        const latest = Math.max(
          -999,
          ...o.votes.filter((v) => frame >= v.at).map((v) => v.at),
        );
        const bump = interpolate(frame, [latest, latest + 10], [1.15, 1], {
          ...clamp,
          easing: Easing.spring({ damping: 9 }),
        });
        return (
          <div
            key={o.label}
            style={{
              position: "relative",
              background: "#fff",
              borderRadius: 12,
              padding: "9px 11px",
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 9,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: `${w}%`,
                background: won
                  ? "rgba(10,124,255,0.16)"
                  : "rgba(10,124,255,0.08)",
              }}
            />
            <div
              style={{
                position: "relative",
                width: 20,
                height: 20,
                borderRadius: "50%",
                border: o.votes.some((v) => v.who === ME && frame >= v.at)
                  ? "none"
                  : "1.5px solid #c7c7cc",
                background: o.votes.some((v) => v.who === ME && frame >= v.at)
                  ? C.blue
                  : "transparent",
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              {o.votes.some((v) => v.who === ME && frame >= v.at) ? (
                <svg width="11" height="9" viewBox="0 0 11 9">
                  <path
                    d="M1 4.5 4 7.5 10 1"
                    stroke="#fff"
                    strokeWidth="2"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
            </div>
            <div
              style={{
                position: "relative",
                flex: 1,
                fontSize: 15.5,
                letterSpacing: -0.2,
                fontWeight: won ? 600 : 400,
              }}
            >
              {o.label}
            </div>
            <div style={{ position: "relative", display: "flex" }}>
              {o.votes
                .filter((v) => frame >= v.at)
                .map((v, j) => (
                  <Avatar
                    key={v.who}
                    who={v.who}
                    size={20}
                    style={{
                      marginLeft: j ? -6 : 0,
                      border: "1.5px solid #fff",
                      boxSizing: "content-box",
                      borderRadius: "50%",
                    }}
                  />
                ))}
            </div>
            <div
              style={{
                position: "relative",
                fontSize: 15,
                color: "#8e8e93",
                width: 12,
                textAlign: "right",
                scale: String(bump),
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {n}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// A rich link: the trip page (photo preview, like iMessage builds from the page's tags) or the
// bank-connect page.
const LinkCard: React.FC<{
  title: string;
  art: "trip" | "connect";
  caption?: string;
}> = ({ title, art, caption }) =>
  art === "trip" ? (
    <LinkPreview
      place="charleston"
      name="Charleston"
      caption={caption ?? ""}
      title={title}
      width={262}
      photoHeight={176}
    />
  ) : (
    <div
      style={{
        width: 262,
        borderRadius: 19,
        overflow: "hidden",
        background: "#e5e5ea",
      }}
    >
      <ConnectArt />
      <div style={{ padding: "9px 13px 10px" }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            lineHeight: 1.25,
            letterSpacing: -0.2,
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 13, color: "#6e6e73", marginTop: 1 }}>
          {SITE}
        </div>
      </div>
    </div>
  );

const ConnectArt: React.FC = () => (
  <div
    style={{
      height: 112,
      background: `linear-gradient(135deg, ${C.navy} 0%, ${C.navyDeep} 100%)`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
    }}
  >
    <AtlasOrb size={46} />
    <div style={{ display: "flex", gap: 4 }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "rgba(255,255,255,0.7)",
          }}
        />
      ))}
    </div>
    <div
      style={{
        width: 46,
        height: 46,
        borderRadius: 13,
        background: C.red,
        color: "#fff",
        fontWeight: 800,
        display: "grid",
        placeItems: "center",
        fontSize: 17,
        fontStyle: "italic",
      }}
    >
      C1
    </div>
  </div>
);
