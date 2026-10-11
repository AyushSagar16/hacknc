import React from "react";
import { Audio } from "@remotion/media";
import {
  linearTiming,
  springTiming,
  TransitionSeries,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  staticFile,
  useVideoConfig,
} from "remotion";
import { CHAT_ACT_DURATION } from "./chat/script";
import { ChatAct } from "./scenes/ChatAct";
import { EndCard } from "./scenes/EndCard";
import { Hook } from "./scenes/Hook";
import { LogoReveal } from "./scenes/LogoReveal";
import { Montage } from "./scenes/Montage";

export const SCENES = {
  hook: 255,
  logo: 150,
  chat: CHAT_ACT_DURATION,
  montage: 120,
  end: 180,
} as const;
export const T = 15;
export const LAUNCH_DURATION =
  Object.values(SCENES).reduce((a, b) => a + b, 0) - 4 * T;

// ~94 s launch film. The soundtrack is laid out to match: drop at 8.0 s (logo), final hit at 88.5 s (end card).
export const AtlasLaunch: React.FC = () => {
  const { fps, durationInFrames } = useVideoConfig();
  const whooshes = [
    SCENES.hook - T,
    SCENES.hook + SCENES.logo - 2 * T,
    SCENES.hook + SCENES.logo + SCENES.chat - 3 * T,
  ];
  return (
    <AbsoluteFill style={{ background: "#f6fafd" }}>
      <TransitionSeries>
        <TransitionSeries.Sequence
          name="Hook"
          durationInFrames={SCENES.hook}
          premountFor={fps}
        >
          <Hook />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: T })}
        />
        <TransitionSeries.Sequence
          name="Logo"
          durationInFrames={SCENES.logo}
          premountFor={fps}
        >
          <LogoReveal />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={slide({ direction: "from-bottom" })}
          timing={springTiming({
            config: { damping: 200 },
            durationInFrames: T,
          })}
        />
        <TransitionSeries.Sequence
          name="Chat"
          durationInFrames={SCENES.chat}
          premountFor={fps}
        >
          <ChatAct />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={wipe({ direction: "from-left" })}
          timing={springTiming({
            config: { damping: 200 },
            durationInFrames: T,
          })}
        />
        <TransitionSeries.Sequence
          name="Montage"
          durationInFrames={SCENES.montage}
          premountFor={fps}
        >
          <Montage />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: T })}
        />
        <TransitionSeries.Sequence
          name="End"
          durationInFrames={SCENES.end}
          premountFor={fps}
        >
          <EndCard />
        </TransitionSeries.Sequence>
      </TransitionSeries>

      <Audio
        name="Music"
        src={staticFile("audio/music.wav")}
        volume={(f) =>
          interpolate(
            f,
            [0, 12, durationInFrames - 30, durationInFrames - 1],
            [0, 0.85, 0.85, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )
        }
      />
      <Sequence
        name="Riser"
        from={6 * fps}
        durationInFrames={2 * fps}
        premountFor={fps}
      >
        <Audio src={staticFile("audio/riser.wav")} volume={0.2} />
      </Sequence>
      {whooshes.map((w) => (
        <Sequence
          key={w}
          name="Whoosh"
          from={w - 6}
          durationInFrames={fps}
          premountFor={fps}
        >
          <Audio src={staticFile("audio/whoosh.wav")} volume={0.4} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
