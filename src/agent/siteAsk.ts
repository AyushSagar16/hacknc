// "Show us the itinerary / plan / website / link": a deterministic, typo-tolerant read of a request
// for the trip's page, so Atlas answers with the real link without a model (and without the speak
// gate staying silent on "Iteneiery"). It needs an ask shape ("what's the...", "show us...", "send
// the...", "where's...", "link to...") or the bare noun as the whole message, so "we should plan",
// "plan b" and "the link to the airbnb" don't match.

const FILLER = new Set([
  "the", "a", "an", "our", "your", "ur", "us", "me", "we", "pls", "plz", "please", "so", "ok", "okay", "hey", "yo", "atlas", "ya", "yall",
  "final", "full", "whole", "complete", "day", "by", "up", "again", "trip", "travel", "all", "of", "over", "to", "real", "quick", "just",
  "can", "could", "you", "u", "and", "then", "now", "also", "wait", "hmm", "um", "that", "this", "new", "latest", "current", "updated",
  "detailed", "rough", "daily", "dayby", "web", "for", "link", "i", "lemme", "let", "like",
]);
// Words that open a request. "link" doubles as one ("link to the itinerary").
const ASK = new Set(["what", "whats", "where", "wheres", "show", "send", "share", "post", "drop", "give", "see", "get", "any", "pull", "need", "want", "wanna", "link", "gimme", "resend"]);
const PLAN_TRAILING = new Set(["again", "please", "pls", "plz", "here", "now", "real", "quick", "rn", "atlas", "everyone", "guys", "thx", "thanks", "so", "far", "tho", "though", "for", "the", "trip", "us", "me", "lol", "ok", "okay", "yet", "then"]);
const STRICT = new Set(["plan", "site", "page", "link", "url"]);
const STRICT_BARE_OK = new Set(["plan"]);

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** "itinerary" and the ways it gets typed: iteniery, itenerary, itinery, iteneiery, intinerary, itin. */
export function looksLikeItinerary(w: string): boolean {
  if (w === "itin" || w === "itins") return true;
  if (w.length < 6 || w.length > 12 || w[0] !== "i") return false;
  return levenshtein(w, "itinerary") <= (w.length >= 8 ? 4 : 3) && /n/.test(w) && /r/.test(w) && /t/.test(w);
}

const isWebsite = (w: string) => /^(?:web ?site|webpage)s?$/.test(w);

function normalize(text: string): string[] {
  const t = text
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/\b(?:do|did) (?:we|you|u|ya|y all) have\b|\bis there\b|\bhave we got\b|\bcan (?:i|we|you|u) (?:get|see|have)\b|\blet me see\b|\bwanna see\b|\bwant to see\b|\bneed to see\b/g, "show")
    .replace(/\bwhat (?:is|are|was)\b|\bwhere (?:is|are)\b/g, (m) => m.startsWith("what") ? "whats" : "wheres")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  return t.split(/\s+/).filter(Boolean);
}

/**
 * Is this message a request for the itinerary / plan / trip page / website / link? `names` are the
 * agent's name and the members' first names (a message opening with a friend's name is for them).
 */
export function asksForTripPage(text: string | null | undefined, opts: { agentName?: string; memberNames?: readonly string[] } = {}): boolean {
  const raw = (text ?? "").trim();
  if (!raw || raw.length > 140) return false;
  const lower = raw.toLowerCase();
  // "leo what's the plan": a question for one friend, not the room.
  const members = (opts.memberNames ?? []).map((n) => n.toLowerCase()).filter((n) => /^[a-z]{2,}$/.test(n));
  if (members.length && new RegExp(`^\\W*(?:${members.join("|")})\\b\\s*[,:]?\\s`, "i").test(lower)) return false;
  const words = normalize(raw);
  if (words.length === 0 || words.length > 14) return false;
  const filler = new Set(FILLER);
  if (opts.agentName) filler.add(opts.agentName.toLowerCase());
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const joined = isWebsite(`${w} ${words[i + 1] ?? ""}`.trim()) && w === "web" ? 2 : 1;
    const itin = looksLikeItinerary(w);
    const site = itin || isWebsite(w) || joined === 2;
    const strict = STRICT.has(w);
    if (!site && !strict) continue;
    // Walk back over filler to the word that opens the ask (or the start of the message).
    let j = i - 1;
    while (j >= 0 && filler.has(words[j]!) && !ASK.has(words[j]!)) j--;
    const opener = j >= 0 ? words[j]! : null;
    // "link" in the filler list is also an opener: back up to it only when it directly leads.
    const asked = opener !== null && ASK.has(opener);
    const rest = words.slice(i + joined);
    if (strict) {
      // "the plan?" / "what's the plan" / "send the link": nothing after but small words, and an
      // opener unless the whole message is the noun (and "trip page"-style nouns need "trip").
      if (!rest.every((r) => PLAN_TRAILING.has(r) || filler.has(r))) {
        // "link to the itinerary" is handled when the noun is the itinerary itself
        continue;
      }
      if (asked) return true;
      const bare = opener === null && words.slice(0, i).every((x) => filler.has(x));
      if (bare && (STRICT_BARE_OK.has(w) || words.slice(0, i).includes("trip"))) return true;
      continue;
    }
    if (asked) return true;
    // The bare word as the whole message: "Iteneiery", "the website", "ok itinerary pls".
    if (opener === null && words.slice(0, i).every((x) => filler.has(x)) && rest.every((r) => filler.has(r) || PLAN_TRAILING.has(r))) return true;
  }
  return false;
}
