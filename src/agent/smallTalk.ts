// Messages with nothing in them for the gate or extraction to read: laughter, acks, emoji.
// Skipping the model on these saves quota in a busy chat. Kept deliberately narrow: "yeah",
// "same" and "no" can carry a preference ("same" after "i want a beach"), so they still go through.
const FILLER = new Set([
  "lol", "lmao", "lmfao", "rofl", "haha", "hahaha", "hehe", "lolol", "ok", "okay", "k", "kk",
  "nice", "wow", "omg", "bet", "ty", "thx", "thanks", "dang", "damn", "oop", "bruh", "ikr", "rip",
]);

export function isSmallTalk(text: string | null | undefined): boolean {
  const words = (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 4) return false;
  // Emoji-only and punctuation-only messages leave no words at all.
  return words.every((w) => {
    // "lmaooo", "omggg", "niceee" → "lmao", "omg", "nice"
    const squeezed = w.replace(/(\p{L})\1+/gu, "$1");
    return FILLER.has(w) || FILLER.has(squeezed) || /^(ha)+h?$|^(lo)+l$|^(he)+$/.test(squeezed);
  });
}
