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
import { Backdrop } from "../components/Backdrop";
import { ConsentSheet } from "../chat/ConsentSheet";
import { Phone } from "../chat/Phone";
import {
  Chapter,
  CHAPTERS,
  CONNECT_SHEET,
  DINGS,
  MESSAGES,
  SIDE,
  START,
} from "../chat/script";
import { clamp } from "../theme";
import { PHONE_SCALE, PHONE_X } from "./chat/Area";
import { Connect } from "./chat/Connect";
import { Food } from "./chat/Food";
import { Fund } from "./chat/Fund";
import { Join } from "./chat/Join";
import { Options } from "./chat/Options";
import { Reads } from "./chat/Reads";
import { Split } from "./chat/Split";
import { Stay } from "./chat/Stay";

const ORDER = Object.keys(CHAPTERS) as Chapter[];
const MOVE = 30;

// One continuous group chat: the phone stays on screen and swaps sides between chapters while each
// chapter's story plays out on the canvas beside it.
export const ChatAct: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  let x: number = PHONE_X[SIDE[ORDER[0]]];
  let tilt = 0;
  ORDER.forEach((k, i) => {
    if (i === 0 || SIDE[k] === SIDE[ORDER[i - 1]]) return;
    const t = START[k] - 10;
    const p = interpolate(frame, [t, t + MOVE], [0, 1], {
      ...clamp,
      easing: Easing.bezier(0.65, 0, 0.25, 1),
    });
    const dx = PHONE_X[SIDE[k]] - PHONE_X[SIDE[ORDER[i - 1]]];
    x += dx * p;
    tilt += Math.sin(p * Math.PI) * Math.sign(dx) * 14;
  });
  const enter = interpolate(frame, [0, 26], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const float = Math.sin(frame / 40) * 6;

  return (
    <AbsoluteFill>
      <Backdrop seed="chat" bubbles={6} />
      <Sequence
        name="Join"
        from={START.join}
        durationInFrames={CHAPTERS.join}
        premountFor={fps}
      >
        <Join />
      </Sequence>
      <Sequence
        name="Connect"
        from={START.connect}
        durationInFrames={CHAPTERS.connect}
        premountFor={fps}
      >
        <Connect />
      </Sequence>
      <Sequence
        name="Reads"
        from={START.reads}
        durationInFrames={CHAPTERS.reads}
        premountFor={fps}
      >
        <Reads />
      </Sequence>
      <Sequence
        name="Options"
        from={START.options}
        durationInFrames={CHAPTERS.options}
        premountFor={fps}
      >
        <Options />
      </Sequence>
      <Sequence
        name="Stay"
        from={START.stay}
        durationInFrames={CHAPTERS.stay}
        premountFor={fps}
      >
        <Stay />
      </Sequence>
      <Sequence
        name="Fund"
        from={START.fund}
        durationInFrames={CHAPTERS.fund}
        premountFor={fps}
      >
        <Fund />
      </Sequence>
      <Sequence
        name="Food"
        from={START.food}
        durationInFrames={CHAPTERS.food}
        premountFor={fps}
      >
        <Food />
      </Sequence>
      <Sequence
        name="Split"
        from={START.split}
        durationInFrames={CHAPTERS.split}
        premountFor={fps}
      >
        <Split />
      </Sequence>

      <div style={{ position: "absolute", inset: 0, perspective: 2400 }}>
        <Phone
          messages={MESSAGES}
          overlay={
            <ConsentSheet
              open={CONNECT_SHEET.open}
              tap={CONNECT_SHEET.tap}
              close={CONNECT_SHEET.close}
            />
          }
          style={{
            left: x,
            top: 46 + float,
            transformOrigin: "0 0",
            scale: String(PHONE_SCALE),
            translate: `0px ${(1 - enter) * 900}px`,
            rotate: `y ${tilt}deg`,
          }}
        />
      </div>

      {ORDER.slice(1).map((k, i) =>
        SIDE[k] === SIDE[ORDER[i]] ? null : (
          <Sequence
            key={k}
            name={`whoosh ${k}`}
            from={START[k] - 12}
            durationInFrames={fps}
            premountFor={fps}
          >
            <Audio src={staticFile("audio/whoosh.wav")} volume={0.32} />
          </Sequence>
        ),
      )}
      {DINGS.map((d) => (
        <Sequence
          key={d}
          name="ding"
          from={d + 2}
          durationInFrames={2 * fps}
          premountFor={fps}
        >
          <Audio src={staticFile("audio/ding.wav")} volume={0.4} />
        </Sequence>
      ))}
      <Sequence
        name="tap link"
        from={CONNECT_SHEET.open - 4}
        durationInFrames={fps}
        premountFor={fps}
      >
        <Audio src={staticFile("audio/tap.wav")} volume={0.5} />
      </Sequence>
    </AbsoluteFill>
  );
};
