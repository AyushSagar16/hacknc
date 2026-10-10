// Adapted from ethanyanghq/scout bridge/tapbacks.ts @ 60f567b89916edb908129c868e3dd4be664b0e07
// Original author: Ethan Yang — used and adapted with the author's explicit permission.
// Changes: literal glyph table (no runtime dependency on Spectrum's Emoji aliases), lookup both ways.

export const TAPBACKS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;
export type Tapback = (typeof TAPBACKS)[number];

const GLYPHS: Record<Tapback, string> = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
};

export function isTapback(name: string): name is Tapback {
  return (TAPBACKS as readonly string[]).includes(name);
}

export function tapbackEmoji(name: Tapback): string {
  return GLYPHS[name];
}

/** Strips variation selectors so "❤" and "❤️" both read as love. */
export function tapbackNamed(emoji: string): Tapback | undefined {
  const bare = emoji.replace(/️/g, "");
  return TAPBACKS.find((t) => GLYPHS[t].replace(/️/g, "") === bare);
}
