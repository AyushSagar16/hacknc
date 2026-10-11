// A private chat is a party of one, but much of what Atlas posts is built for a group ("~$765
// each", "where are we going? tap to vote", "1 of 1 votes", "how everyone gets to orlando").
// Everything queued for a private chat passes through here first, so it reads as talking to one
// person in the same voice as the group chat.
import type { Action } from "./outbound.ts";

const RULES: [RegExp, string][] = [
  [/\bper person for /g, "for "],
  [/\bper person, /g, ""],
  [/(~?\$[\d,]+(?:\.\d\d)?) each\b/g, "$1"],
  [/\b(spots?) (fits?) everyone\b/g, "$1 $2"],
  [/\bthat's the one that fits everyone\b/g, "that's the one that fits"],
  [/\bnothing in my list fits everyone\b/g, "nothing in my list fits"],
  [/\bnothing fits everyone\b/g, "nothing fits"],
  [/\bno (\w+) spots fit everyone\b/g, "no $1 spots fit"],
  [/\bwhere are we going\? tap to vote 🗳️/g, "which one sounds best? tap to pick 🗳️"],
  [/ (?:unanimous, \d+ for \d+|\d+ of \d+ votes?)(?=\n|$)/g, ""],
  [/\blocked in\. now we just need dates\b/g, "locked in. now just your dates"],
  [/\bhow everyone gets to /g, "getting you to "],
  [/\btravel's on each of you, separate from the shared costs\. /g, ""],
  [/\beveryone's good up to\b/g, "you're good up to"],
  [/\bwhat kind of food is everyone into\b/g, "what kind of food are you into"],
  [/\bwhere are we thinking, and when\?/g, "where are you thinking of heading, and when?"],
  [/\bwhen are we thinking of going\?/g, "when are you thinking of going?"],
];

/** `names`: the person's first name(s), lowercase ("ayush"), for "adventure for ayush" and "- ayush: …". */
export function soloText(text: string, names: string[] = []): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  for (const n of names.filter((x) => /^[a-z][a-z'-]+$/.test(x))) {
    out = out.replace(new RegExp(` for ${n}(?=\\n|$|[.,])`, "gm"), "");
    out = out.replace(new RegExp(`^- ${n}: `, "gm"), "- ");
  }
  return out;
}

export function soloActions(actions: Action[], names: string[] = []): Action[] {
  return actions.map((a) => {
    if (a.type === "say") return { ...a, text: soloText(a.text, names) };
    if (a.type === "poll") return { ...a, title: soloText(a.title, names) };
    return a;
  });
}
