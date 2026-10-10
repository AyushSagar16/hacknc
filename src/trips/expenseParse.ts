// Rule-based first pass at "i paid 64 for dinner": a sender logging a payment they made.
// It only reads clean, single-amount statements; anything it isn't sure of (questions,
// prices being discussed, someone else paying, refunds, rates, two numbers) returns null
// so the model can take it from there.

import { type Cents, MoneyError, toCents } from "../money/cents.ts";

export type ParsedExpense = {
  amountCents: Cents;
  description: string;
  /** Member names in mention order, the sender as "me"; null means everyone. */
  splitAmong: string[] | null;
  confidence: "high" | "low";
};

const ME = "me";
const SELF = new Set(["me", "i", "myself", "my", "mine"]);

const QUESTION =
  /\?|^(?:should|can|could|would|will|shall|do|does|did|is|are|was|were|who|what|how|when|where|why|which|may|might)\b/i;
// Refunds and paybacks, negations, plans, and per-person prices.
const NOT_A_PAYMENT =
  /\b(?:refunds?|refunded|reimburs\w*|back|owes?|owed|owing|not|never|didn'?t|haven'?t|hasn'?t|won'?t|can'?t|don'?t|dont|i'?ll|i will|we'?ll|we will|gonna|going to|about to|might|would|could|should|if|maybe|probably|per|each|apiece|pp)\b/i;
// A rate right after the amount: "120 a night", "$30/person".
const RATE =
  /\d(?:\s?k)?(?:\s*(?:bucks?|dollars?|usd))?\s*(?:\/\s*|\b(?:a|an)\s+)(?:person|head|night|day|week|pop|piece|ticket|hour)\b/i;

const PREFIX = String.raw`^(?:(?:i|i've|ive)\s+)?(?:(?:just|already|also|finally|actually)\s+)*`;
const PAID = String.raw`(?:paid|covered|spent|fronted|dropped|put down|put)`;
const GOT = String.raw`(?:got|grabbed|bought|picked up)`;
// The lookbehinds keep the amount from starting mid-number or mid-word.
const AMOUNT = String.raw`(?<![\w.,])(?:(?<approx>about|around|like|roughly|approx\.?|approximately|~)\s*)?(?<dollar>\$\s?)?(?<![\d.,])(?<digits>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(?<k>k))?(?:\s*(?:bucks?|dollars?|usd))?(?![a-z\d])`;
const SPLIT_WORD = String.raw`(?:split|splitting|shared|sharing|divided|dividing)`;

// "i paid 64 for dinner", "spent $45 on gas", "paid 90, split with leo"
const AMOUNT_FIRST = new RegExp(
  String.raw`${PREFIX}${PAID}\s+${AMOUNT}(?:\s+(?:for|on|at|towards?)\s+(?<rest>.+)|(?<tail>,\s*.+))?$`,
  "i",
);
// "i covered gas $45", "i got dinner, it was 64", "bought tickets for $30"
const AMOUNT_LAST = new RegExp(
  String.raw`${PREFIX}(?:${PAID}|${GOT})\s+(?:for\s+)?(?<rest>.+?)\s*(?:[,:\-–—]\s*)?(?:(?:it|that|which|this)\s+(?:was|came to|came out to|cost|ran)\s+|(?:was|for|at|costs?)\s+|=\s*)?${AMOUNT}(?<tail>\s*,.*|\s+(?:and\s+)?${SPLIT_WORD}\b.*)?$`,
  "i",
);

const SPLIT_CLAUSE = new RegExp(String.raw`(?:^|,\s*|\s+)(?:and\s+)?${SPLIT_WORD}\b(?<how>.*)$`, "i");
const SPLIT_HOW =
  /^(?:(?:it|this|that)\s+)?(?:evenly|equally)?\s*(?:(?<prep>with|between|among|amongst|w\/)\s*(?<who>.+))?$/i;
const EVERYONE =
  /^(?:everyone|everybody|the (?:whole )?group|all of us|us all|us|the crew|the squad|the gang|y'?all|all)$/i;
const FOR_EVERYONE =
  /\s+(?:for|with)\s+(?:everyone|everybody|the (?:whole )?group|all of us|us all|us|the crew|the squad|the gang|y'?all|all)$/i;
const DETERMINER = /^(?:the|a|an|our|some|this|that|these|those)\s+/i;
const PAYMENT_WORD = /\b(?:paid|pay|pays|paying|covered|venmo\w*|owe\w*)\b/i;
const PERSON_PAID = /^(?:you|u|him|her|them|ya)\b/i;

/**
 * Reads a sender's own payment, e.g. "i paid 30 for me and maya's tickets" →
 * { amountCents: 3000, description: "tickets", splitAmong: ["me", "Maya"] }.
 * `memberNames` are the trip members' first names, matched case-insensitively.
 */
export function parseExpense(text: string, memberNames: readonly string[]): ParsedExpense | null {
  const s = normalize(text);
  // A clean statement is short; long messages go to the model.
  if (!s || s.length > 280 || QUESTION.test(s) || NOT_A_PAYMENT.test(s) || RATE.test(s)) return null;
  // One figure only: "64 for dinner and 20 for drinks", "2 tickets" and "the 14th" all bail.
  if ((s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).length !== 1) return null;

  let detail: string;
  const first = AMOUNT_FIRST.exec(s);
  const last = first ? null : AMOUNT_LAST.exec(s);
  const groups = first?.groups ?? last?.groups;
  if (!groups) return null;
  if (first) {
    detail = groups.rest ?? (groups.tail ?? "").replace(/^,\s*(?:(?:for|on)\s+)?/i, "");
  } else {
    const rest = groups.rest ?? "";
    // "paid maya 40" is paying a person back, not buying something.
    if (PERSON_PAID.test(rest) || (startsWithName(rest, memberNames) && !/'s\b/i.test(rest))) return null;
    detail = rest + (groups.tail ?? "");
  }

  const amountCents = readAmount(groups.digits ?? "", groups.k !== undefined);
  if (amountCents === null) return null;

  const read = readDetail(detail, memberNames);
  if (!read) return null;
  const personal = read.splitAmong?.length === 1 && read.splitAmong[0] === ME;
  const vague = read.description === "" || groups.approx !== undefined || personal;
  return {
    amountCents,
    description: read.description,
    splitAmong: read.splitAmong,
    confidence: vague ? "low" : "high",
  };
}

function normalize(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:@\S+\s*)+/, "")
    .replace(/^(?:(?:atlas|ok|okay|so|fyi|btw|hey|yo|alright|update)\b[,:!]?\s*)+/i, "")
    .replace(
      /(?:[\s.!,;:\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]|\b(?:lol|lmao|haha+|fyi|btw|rn|tho|though|thx|thanks)\b)+$/iu,
      "",
    );
}

function readAmount(digits: string, thousands: boolean): Cents | null {
  let cents: Cents;
  try {
    cents = toCents(digits);
  } catch (err) {
    if (err instanceof MoneyError) return null;
    throw err;
  }
  if (thousands) cents *= 1000;
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null;
}

/** Splits "the boat, split with leo" into a description and who shared it. */
function readDetail(
  detail: string,
  members: readonly string[],
): { description: string; splitAmong: string[] | null } | null {
  let item = detail.trim();
  // `undefined` = nobody said; null = everyone.
  let who: string[] | null | undefined;
  const decide = (names: string[] | null): boolean => {
    if (who !== undefined) return who === null && names === null; // said two ways: ambiguous unless both mean everyone
    who = names;
    return true;
  };

  const clause = SPLIT_CLAUSE.exec(item);
  if (clause) {
    const how = SPLIT_HOW.exec((clause.groups?.how ?? "").trim());
    if (!how) return null;
    item = item.slice(0, clause.index);
    const people = how.groups?.who?.trim();
    if (!people || EVERYONE.test(people)) {
      decide(null);
    } else {
      const names = parseNames(people, members);
      if (!names) return null;
      const withMe = how.groups?.prep?.toLowerCase().startsWith("w") ?? false;
      decide(withMe ? [ME, ...names.filter((n) => n !== ME)] : names);
    }
  }
  item = item.replace(/[\s,;:-]+$/, "").trim();

  if (FOR_EVERYONE.test(item)) {
    item = item.replace(FOR_EVERYONE, "");
    if (!decide(null)) return null;
  }

  const whole = parseNames(item, members);
  const possessive = /^(?<owner>.+?)'s\s+(?<thing>.+)$/i.exec(item);
  const forWhom = /^(?<thing>.+)\s+(?<prep>for|with)\s+(?<who>.+)$/i.exec(item);
  if (item && whole) {
    // "i paid 30 for leo"
    if (!decide(whole)) return null;
    item = "";
  } else if (possessive?.groups) {
    // "me and maya's tickets"; "the airbnb's deposit" is just a description.
    const owner = possessive.groups.owner ?? "";
    const names = parseNames(owner, members);
    if (names) {
      if (!decide(names)) return null;
      item = possessive.groups.thing ?? "";
    } else if (!DETERMINER.test(`${owner} `)) {
      return null; // someone we don't know
    }
  } else if (forWhom?.groups && parseNames(forWhom.groups.who ?? "", members)) {
    // "dinner for leo and priya", "dinner with leo"
    const names = parseNames(forWhom.groups.who ?? "", members) ?? [];
    const withMe = forWhom.groups.prep?.toLowerCase() === "with";
    if (!decide(withMe ? [ME, ...names.filter((n) => n !== ME)] : names)) return null;
    item = forWhom.groups.thing ?? "";
  } else if (/^my\s+/i.test(item)) {
    // "my uber": the sender's own cost
    if (!decide([ME])) return null;
    item = item.replace(/^my\s+/i, "");
  }

  const description = item
    .replace(DETERMINER, "")
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, "")
    .replace(/^(?:for|on|it|that|this|towards?)$/i, "");
  if (PAYMENT_WORD.test(description) || mentionsMember(description, members)) return null;
  return { description, splitAmong: who ?? null };
}

/** "me, leo and priya's" → ["me", "Leo", "Priya"]; null unless every part is a person. */
function parseNames(text: string, members: readonly string[]): string[] | null {
  const parts = text
    .split(/\s*,\s*(?:and\s+|&\s*)?|\s+(?:and|&|\+)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const names: string[] = [];
  for (const part of parts) {
    const word = part.replace(/'s$/i, "").toLowerCase();
    const name = SELF.has(word) ? ME : members.find((m) => m.toLowerCase() === word);
    if (!name) return null;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function startsWithName(text: string, members: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return members.some((m) => {
    const name = m.toLowerCase();
    return lower === name || (lower.startsWith(name) && /^[^\w]/.test(lower.slice(name.length)));
  });
}

function mentionsMember(text: string, members: readonly string[]): boolean {
  const words = new Set(text.toLowerCase().split(/[^\w']+/).map((w) => w.replace(/'s$/, "")));
  return members.some((m) =>
    m.includes(" ") ? text.toLowerCase().includes(m.toLowerCase()) : words.has(m.toLowerCase()),
  );
}
