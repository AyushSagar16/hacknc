// Money is integer cents everywhere in Atlas. This module turns what people type into
// cents exactly (string arithmetic, never float * 100), writes cents back the way people
// text money, and spots dollar figures in free text for the money guard.

export type Cents = number;

export class MoneyError extends Error {
  override name = "MoneyError";
}

export type MoneyMention = { cents: Cents; raw: string; index: number };

/**
 * Parses an amount of dollars into cents: 64, 64.5, "64", "$1,240.50", " $12 ".
 * Throws MoneyError for NaN, Infinity, empty input, sub-cent precision (10.005) or a
 * negative amount unless `allowNegative` is set.
 */
export function toCents(input: number | string, opts: { allowNegative?: boolean } = {}): Cents {
  let text: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new MoneyError(`not an amount: ${input}`);
    // The shortest round-trip form, so 64.5 reads "64.5" and 10.005 reads "10.005".
    text = String(input);
    if (/e/i.test(text)) throw new MoneyError(`amount out of range: ${input}`);
  } else {
    text = input;
  }

  let s = text.trim();
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trimStart();
  }
  if (s.startsWith("$")) s = s.slice(1).trimStart();
  if (!negative && s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trimStart();
  }

  const m = /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d*))?$/.exec(s);
  const intDigits = m?.[1];
  const fracDigits = m?.[2] ?? "";
  if (!m || (intDigits === undefined && fracDigits === "")) {
    throw new MoneyError(`not an amount: "${text}"`);
  }
  if (fracDigits.length > 2) throw new MoneyError(`more than 2 decimal places: "${text}"`);

  const cents = decimalToCents(intDigits ?? "0", fracDigits);
  if (cents === null) throw new MoneyError(`amount out of range: "${text}"`);
  if (negative && cents > 0 && !opts.allowNegative) {
    throw new MoneyError(`negative amount not allowed: "${text}"`);
  }
  return negative ? 0 - cents : cents;
}

/**
 * Formats cents the way people text money: "$1,240", "$236.50", "$0.05", "-$1.95".
 * `cents: "auto"` (the default) drops ".00"; `"always"` keeps it.
 */
export function formatUsd(c: Cents, opts: { cents?: "auto" | "always" } = {}): string {
  if (!Number.isSafeInteger(c)) throw new MoneyError(`not a whole number of cents: ${c}`);
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  const rest = abs % 100;
  const dollars = String((abs - rest) / 100).replace(/\B(?=(\d{3})+$)/g, ",");
  if (rest === 0 && opts.cents !== "always") return `${sign}$${dollars}`;
  return `${sign}$${dollars}.${String(rest).padStart(2, "0")}`;
}

// One number, optionally with a "$", a magnitude suffix and a unit word. The lookbehind
// and lookahead stop it from starting or ending inside a larger number ("1,2345", "1.2.3")
// or a word ("14th", "3pm", "5km").
const NUMBER =
  /(?<![\w$]|\d[.,])(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(k|grand|thousand|million|mil|mm|m))?(?!\w|[.,]\d)(?:\s*(bucks?|dollars?|usd)\b)?/gi;

// Units that make a bare "4.50" something other than money.
const NOT_MONEY_AFTER =
  /^\s*(?:%|percent\b|[ap]\.?m\b|miles?\b|mi\b|km\b|hours?\b|hrs?\b|mins?\b|minutes?\b|lbs?\b|kg\b|stars?\b|x\b)/i;

const RANGE_DASH = /^\s*[-–—]\s*$/;

type NumberToken = {
  raw: string;
  index: number;
  end: number;
  int: string;
  frac: string;
  shift: number; // powers of ten from the suffix: 3 for "k", 6 for "million"
  marked: boolean; // has "$", a unit word, or a money-only suffix ("k", "grand")
};

/**
 * Finds dollar figures in free text, in order: "$1,200", "$64", "64 bucks", "1.2k",
 * "$1.2k", "600 dollars", "64.50", and both ends of a range like "$40-60". A bare whole
 * number ("the 14th", "7", "3 people") is not money.
 */
export function parseMoneyMentions(text: string): MoneyMention[] {
  const tokens: NumberToken[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const suffix = m[4]?.toLowerCase();
    const shift = suffix === undefined ? 0 : /^(k|grand|thousand)$/.test(suffix) ? 3 : 6;
    tokens.push({
      raw: m[0],
      index: m.index,
      end: m.index + m[0].length,
      int: m[2] ?? "",
      frac: m[3] ?? "",
      shift,
      marked: m[1] !== undefined || m[5] !== undefined || suffix === "k" || suffix === "grand",
    });
  }

  const money = tokens.map(
    (t) => t.marked || (t.shift === 0 && t.frac.length === 2 && !NOT_MONEY_AFTER.test(text.slice(t.end))),
  );
  // In a range, one marked end makes both ends money; "1-2k" means 1k to 2k.
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    if (!RANGE_DASH.test(text.slice(a.end, b.index)) || !(a.marked || b.marked)) continue;
    money[i] = money[i + 1] = true;
    if (a.shift === 0 && b.shift > 0 && numeric(a) < numeric(b)) a.shift = b.shift;
  }

  const mentions: MoneyMention[] = [];
  tokens.forEach((t, i) => {
    if (!money[i]) return;
    const cents = decimalToCents(t.int, t.frac, t.shift);
    if (cents !== null) mentions.push({ cents, raw: t.raw, index: t.index });
  });
  return mentions;
}

function numeric(t: NumberToken): number {
  return Number(`${t.int.replace(/,/g, "")}.${t.frac || "0"}`);
}

// Exact: ("1,240", "5") -> 124050. `shift` adds powers of ten for a suffix like "k".
// Null when the figure is finer than a cent or too large to hold exactly.
function decimalToCents(intDigits: string, fracDigits: string, shift = 0): Cents | null {
  const scale = 2 + shift;
  if (fracDigits.length > scale) return null;
  const big = BigInt(intDigits.replace(/,/g, "") + fracDigits.padEnd(scale, "0"));
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(big);
}
