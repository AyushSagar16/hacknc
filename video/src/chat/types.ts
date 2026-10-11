// A scripted iMessage group chat. `at` is the frame (in the phone's own timeline) a message lands.
export type Who = "maya" | "leo" | "priya" | "atlas";

export type Vote = { who: Who; at: number };

export type Msg =
  | { kind: "system"; at: number; text: string }
  | {
      kind: "text";
      at: number;
      from: Who;
      text: string;
      // Frames of typing shown before the message lands (a typing bubble, or Maya's input field).
      typing?: number;
      react?: { emoji: string; at: number };
    }
  | {
      kind: "poll";
      at: number;
      from: Who;
      title: string;
      options: { label: string; votes: Vote[] }[];
    }
  | {
      kind: "link";
      at: number;
      from: Who;
      title: string;
      site: string;
      art: "trip" | "connect";
    };

// Maya holds the phone: her messages are the blue ones.
export const ME: Who = "maya";

export const NAMES: Record<Who, string> = {
  maya: "Maya",
  leo: "Leo",
  priya: "Priya",
  atlas: "Atlas",
};
