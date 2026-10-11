import React from "react";
import { ChapterOut, Chip } from "../../components/Glass";
import { Eyebrow, Headline, Sub } from "../../components/Text";
import { Area } from "./Area";

export const Join: React.FC = () => (
  <ChapterOut>
    <Area side="left">
      <div style={{ position: "absolute", top: 250 }}>
        <Eyebrow at={6}>Meet Atlas</Eyebrow>
        <Headline
          at={12}
          size={104}
          text={"Add one number\nto the *group chat.*"}
          style={{ marginTop: 34 }}
        />
        <Sub at={44} size={38} style={{ marginTop: 26, maxWidth: 940 }}>
          No app to download. No forms to fill out. Atlas introduces itself,
          then reads along.
        </Sub>
        <div style={{ display: "flex", gap: 14, marginTop: 40 }}>
          <Chip at={70} tone="accent">
            💬 Lives in iMessage
          </Chip>
          <Chip at={78}>✈️ Plans the trip</Chip>
          <Chip at={86}>💸 Handles the money</Chip>
        </div>
      </div>
    </Area>
  </ChapterOut>
);
