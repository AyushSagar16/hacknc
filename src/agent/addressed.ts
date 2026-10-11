// Adapted from ethanyanghq/scout src/scout/speak_gate.py (is_addressed_to_scout) and
// src/scout/trip.py (ADDRESSES_SCOUT) @ 60f567b89916edb908129c868e3dd4be664b0e07
// Original author: Ethan Yang — used and adapted with the author's explicit permission.
// Changes: the name is configurable (AGENT_NAME); trailing vocatives ("thoughts, atlas?") count;
// threaded replies are matched by provider message id instead of exact text; an open question
// from Atlas stays answerable for a few human messages / 15 minutes instead of exactly one, and
// a question aimed at one person ("maya, ...?") only counts as answered by that person.
import type { MessageRow } from "../db/repos/core.ts";
import { isSmallTalk } from "./smallTalk.ts";
import { aimedAtSomeone } from "./speakGate.ts";

export interface AddressedInput {
  message: Pick<MessageRow, "text" | "person_id" | "reply_to_provider_id" | "sent_at" | "id">;
  /** Recent history in this chat, oldest first, including the message itself. */
  history: Pick<MessageRow, "id" | "direction" | "kind" | "text" | "person_id" | "sent_at" | "provider_message_id" | "meta">[];
  agentName: string;
  /** Lowercase first names by person id, to tell who an Atlas question was aimed at. */
  namesById: ReadonlyMap<number, string>;
}

export type AddressedReason = "named" | "reply_to_atlas" | "answers_question" | null;

/** "atlas seems useful", "atlas is so organized": talking about Atlas, not to it. */
const ABOUT_WORDS = "seems|is|was|looks|sounds|has|had|knows|says|said|thinks|be|been|being|kinda|really|literally|lowkey|just|always|never";

export function mentionPattern(agentName: string): RegExp {
  const n = agentName.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Addressing: "@atlas", "hey atlas", a message that starts with the name (unless the next word
  // is about Atlas, like "seems"), "atlas ...?", a bare "atlas", or a trailing vocative
  // ("thoughts, atlas?"), or the name as its own sentence or vocative mid-message ("i'm free.
  // atlas. let's keep moving", "ok. atlas, what now"). "let's ask atlas later" is left to the gate.
  return new RegExp(
    `(?:@${n}\\b|\\b(?:at|hey|hi|hello|yo|ok|okay|thanks|thx|ty|sup)\\s+${n}\\b|^\\W*${n}\\b(?!\\s+(?:${ABOUT_WORDS})\\b)(?:\\W|$)|^\\W*${n}\\b.*\\?\\s*$|[,!]\\s*${n}\\W*$|\\b${n}\\s*\\?\\s*$|[.!?\\n]\\s*${n}\\s*[.!,:]|^\\W*${n}\\s*[.!,:])`,
    "i",
  );
}

export function mentionsAgent(text: string, agentName: string): boolean {
  return mentionPattern(agentName).test(text);
}

const OPEN_QUESTION_MS = 15 * 60_000;
const OPEN_QUESTION_MESSAGES = 3;

export function addressedReason(input: AddressedInput): AddressedReason {
  const { message, history, agentName } = input;
  if (mentionsAgent(message.text, agentName)) return "named";

  if (message.reply_to_provider_id) {
    const target = message.reply_to_provider_id;
    const isAtlas = history.some(
      (h) =>
        h.direction === "outbound" &&
        (h.provider_message_id === target || ((h.meta?.providerIds as string[] | undefined) ?? []).includes(target)),
    );
    return isAtlas ? "reply_to_atlas" : null;
  }

  // Answer to an open question from Atlas? Not when it's said to a friend ("priya do u have a car").
  if (aimedAtSomeone(message.text, [...input.namesById.entries()].filter(([id]) => id !== message.person_id).map(([, n]) => n))) return null;
  const idx = history.findIndex((h) => h.id === message.id);
  // Atlas's own tapbacks (a 👍 on someone's answer) don't close its question for everyone else.
  const before = (idx === -1 ? history : history.slice(0, idx)).filter((h) => (h.kind === "text" || h.direction === "outbound") && !(h.direction === "outbound" && h.kind === "reaction"));
  let humanSince = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const h = before[i]!;
    if (h.direction === "outbound") {
      // Atlas's latest run of bubbles, newest first: a question in any of them is open, not only in
      // the last one ("sakshi, where are you driving from?" then a travel board that ends without "?").
      let j = i;
      for (; j >= 0 && before[j]!.direction === "outbound"; j--) {
        const b = before[j]!;
        if (b.kind !== "text" || !b.text.trim().endsWith("?")) continue;
        if (message.sent_at.getTime() - b.sent_at.getTime() > OPEN_QUESTION_MS) break;
        const aimedAt = aimedAtName(b.text, input.namesById);
        if (aimedAt !== null && aimedAt !== message.person_id) continue;
        // A bare "ok"/"lol" to a question for the room answers nothing; only the person asked by name
        // can answer with a bare ack.
        if (aimedAt === null && isSmallTalk(message.text)) continue;
        return "answers_question";
      }
      return null;
    }
    humanSince += 1;
    if (humanSince >= OPEN_QUESTION_MESSAGES) return null;
  }
  return null;
}

/**
 * "maya, when can you go?" or "want me to add you to the payment plan, zoe?" → that person's id.
 * null when the question is for the room (or for several people).
 */
export function aimedAtName(text: string, namesById: ReadonlyMap<number, string>): number | null {
  const lastLine = text.trim().split("\n").at(-1) ?? "";
  // "got it. sakshi, where are you driving from?": the question's own sentence can lead with the name.
  const lastSentence = lastLine.split(/(?<=[.!])\s+/).at(-1) ?? "";
  const leadOf = (t: string) => /^\W*(?:(?:ok|okay|so|alright|got it|cool|nice)\W+)?([a-z]+)\s*[,:]/i.exec(t)?.[1]?.toLowerCase();
  const trail = /,\s*([a-z]+)\s*\?\s*$/i.exec(lastLine)?.[1]?.toLowerCase();
  for (const who of [leadOf(lastLine), leadOf(lastSentence), leadOf(text), trail]) {
    if (!who) continue;
    for (const [id, name] of namesById) if (name === who) return id;
  }
  return null;
}
