import React from "react";
import { Composition, Folder } from "remotion";
import { AtlasLaunch, LAUNCH_DURATION, SCENES } from "./AtlasLaunch";
import { BENTO, BentoSheet } from "./BentoSheet";
import { THUMB, Thumbnail } from "./Thumbnail";
import { ChatAct } from "./scenes/ChatAct";
import { EndCard } from "./scenes/EndCard";
import { Hook } from "./scenes/Hook";
import { LogoReveal } from "./scenes/LogoReveal";
import { Montage } from "./scenes/Montage";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Folder name="Scenes">
        <Composition
          id="Hook"
          component={Hook}
          width={1920}
          height={1080}
          fps={30}
          durationInFrames={SCENES.hook}
        />
        <Composition
          id="Logo"
          component={LogoReveal}
          width={1920}
          height={1080}
          fps={30}
          durationInFrames={SCENES.logo}
        />
        <Composition
          id="Chat"
          component={ChatAct}
          width={1920}
          height={1080}
          fps={30}
          durationInFrames={SCENES.chat}
        />
        <Composition
          id="Montage"
          component={Montage}
          width={1920}
          height={1080}
          fps={30}
          durationInFrames={SCENES.montage}
        />
        <Composition
          id="End"
          component={EndCard}
          width={1920}
          height={1080}
          fps={30}
          durationInFrames={SCENES.end}
        />
      </Folder>
      <Composition
        id="AtlasLaunch"
        component={AtlasLaunch}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={LAUNCH_DURATION}
      />
      <Composition
        id="BentoSheet"
        component={BentoSheet}
        width={BENTO.width}
        height={BENTO.height}
        fps={30}
        durationInFrames={BENTO.frames}
      />
      <Composition
        id="Thumbnail"
        component={Thumbnail}
        width={THUMB.width}
        height={THUMB.height}
        fps={30}
        durationInFrames={THUMB.frames}
      />
    </>
  );
};
