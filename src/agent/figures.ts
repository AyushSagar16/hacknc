// The money guard. Every dollar figure Atlas shows the group must trace to a Nessie call or a
// labeled estimate, so tools and saved state register each figure they produce, with its source
// and visibility. Before the model's words go out, every figure in them must match a registered
// figure the audience may see; otherwise the model's text is dropped for the tools' templates.
import { parseMoneyMentions, type MoneyMention } from "../money/cents.ts";

export interface Figure {
  cents: number;
  label: string;
  /** "nessie:<object id>", "estimate:<what>", "live:<provider>", "ledger:<expense id>" ... */
  source: string;
  visibility: "public" | "private";
  /** For private figures: the one person allowed to see it (in a DM). */
  ownerId?: number;
}

export interface GuardResult {
  ok: boolean;
  unknown: MoneyMention[];
  privateLeaks: { mention: MoneyMention; figure: Figure }[];
}

export class Figures {
  private readonly items: Figure[] = [];

  add(f: Figure): void {
    if (Number.isFinite(f.cents)) this.items.push(f);
  }

  addAll(fs: Iterable<Figure>): void {
    for (const f of fs) this.add(f);
  }

  all(): readonly Figure[] {
    return this.items;
  }

  /**
   * Check a message bound for an audience. In a group chat only public figures may appear; in a
   * DM the viewer's own private figures are allowed too.
   */
  check(text: string, audience: { isGroup: boolean; viewerId?: number }): GuardResult {
    const unknown: MoneyMention[] = [];
    const privateLeaks: GuardResult["privateLeaks"] = [];
    for (const mention of [...parseMoneyMentions(text), ...bareMoneyMentions(text)]) {
      const hedged = /(about|around|roughly|approx\.?|~|like|under|over|almost|nearly)\s*$/i.test(text.slice(Math.max(0, mention.index - 14), mention.index));
      const matches = this.items.filter((f) => close(mention, f.cents, hedged));
      if (matches.length === 0) {
        unknown.push(mention);
        continue;
      }
      const allowed = matches.some((f) => f.visibility === "public" || (!audience.isGroup && f.ownerId === audience.viewerId));
      if (!allowed) privateLeaks.push({ mention, figure: matches[0]! });
    }
    return { ok: unknown.length === 0 && privateLeaks.length === 0, unknown, privateLeaks };
  }

  /** A compact list for the model: the figures it may quote and where they come from. */
  describe(audience: { isGroup: boolean; viewerId?: number }, limit = 40): string[] {
    return this.items
      .filter((f) => f.visibility === "public" || (!audience.isGroup && f.ownerId === audience.viewerId))
      .slice(-limit)
      .map((f) => `${dollars(f.cents)} — ${f.label} (${sourceKind(f.source)})`);
  }
}

/** The model sees Nessie-backed figures as coming from the bank, the way the chat talks about them. */
function sourceKind(source: string): string {
  const kind = source.split(":")[0]!;
  return kind.startsWith("nessie") ? "bank" : kind;
}

/** Rounded or hedged mentions ("$1.2k", "about $600", "$550") get more slack than exact ones. */
function close(m: MoneyMention, cents: number, hedged: boolean): boolean {
  const roundHundreds = /k\b|grand/i.test(m.raw) || m.cents % 10_000 === 0;
  const roundTens = m.cents % 1_000 === 0;
  const pct = hedged || roundHundreds ? 0.05 : roundTens ? 0.02 : 0.005;
  const tolerance = Math.max(100, Math.abs(cents) * pct);
  return Math.abs(Math.abs(m.cents) - Math.abs(cents)) <= tolerance;
}

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: c % 100 === 0 ? 0 : 2, minimumFractionDigits: c % 100 === 0 ? 0 : 2 })}`;

/** Words that make a bare number a price ("tickets are about 115 to 150", "150 bucks" is already caught elsewhere). */
const MONEY_CONTEXT = /\b(?:tickets?|costs?|costing|prices?|priced|pricing|fares?|fees?|admission|per person|per night|a night|\/night|pp|bucks|dollars|usd|cheap|expensive|spend|spending|pay|paying|runs? you|set you back)\b/i;
/** What a bare number is when one of these follows it: a count, a date, a rating, a unit. */
const UNIT_AFTER = /^\s*(?:nights?|days?|weeks?|people|persons?|guests?|adults?|kids|children|rooms?|beds?|bedrooms?|baths?|stars?|reviews?|ratings?|miles?|mi\b|km\b|mins?\b|minutes?|hours?|hrs?\b|[ap]\.?m\b|am\b|pm\b|th\b|st\b|nd\b|rd\b|%|percent|years?|yrs?|x\b|degrees|°|f\b|c\b|of\b|tickets?|seats?|spots?|stops?|restaurants?|places?|options?|things?|minutes?|photos?)/i;
const MONTH_BEFORE = /(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|#|no\.?|room|route|highway|exit|gate|apt|suite|flight)\.?\s*$/i;
const MONTH_AFTER = /^\s*(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

/**
 * Prices written without a "$" ("about 115 to 150" next to "tickets", "200 per person"): treated
 * like dollar figures so the model can't quote prices from memory. Needs a money word within the
 * same sentence and a whole number of at least 10 that is not a year, a date, a count or a rating.
 */
export function bareMoneyMentions(text: string): MoneyMention[] {
  const marked = parseMoneyMentions(text);
  const out: MoneyMention[] = [];
  for (const m of text.matchAll(/(?<![\w$.,\/:#-]|\d[.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\w:]|[.,]\d|\/)/g)) {
    const index = m.index;
    const end = index + m[0].length;
    if (marked.some((k) => index >= k.index && index < k.index + k.raw.length)) continue;
    const whole = Number(m[1]!.replace(/,/g, ""));
    if (whole < 10 || (whole >= 1900 && whole <= 2100 && !m[2])) continue;
    const rest = text.slice(end);
    if (UNIT_AFTER.test(rest) || MONTH_AFTER.test(rest) || MONTH_BEFORE.test(text.slice(0, index))) continue;
    // Context: the same line, within ~45 characters either side, not crossing a sentence end.
    const before = text.slice(Math.max(0, index - 45), index).split(/[.!?\n]\s/).pop()!.split("\n").pop()!;
    const after = rest.slice(0, 45).split(/[.!?]\s|\n/)[0]!;
    if (!MONEY_CONTEXT.test(before) && !MONEY_CONTEXT.test(after)) continue;
    const cents = Math.round(Number(`${m[1]!.replace(/,/g, "")}.${m[2] ?? "0"}`) * 100);
    out.push({ cents, raw: m[0], index });
  }
  return out;
}
