// Turn a lookup's items into one clean iMessage bubble: lowercase, numbered, no markdown, no
// citation marks, no URLs, no prices. Deterministic, so every list Atlas posts looks the same.

export interface ListItem {
  name: string;
  detail?: string;
  /** Events only: the dates the sources give (yyyy-mm-dd). */
  start?: string;
  end?: string;
}

export const MAX_ITEMS = 5;
/** Two solid, verified items beat three where one is made up. */
export const MIN_ITEMS = 2;
export const MAX_ITEM_CHARS = 90;
/** How far past MAX_ITEM_CHARS a line may run to keep its detail whole. */
export const ITEM_SLACK = 10;

/** Remove what grounded answers leave behind: [1], [1, 2], [cite: 3], 【4†source】, (source), markdown, URLs. */
export function stripArtifacts(text: string): string {
  return (
    text
      .replace(/\[(?:cite|citation|source)[^\]]*\]/gi, "")
      .replace(/\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/g, "")
      .replace(/【[^】]*】/g, "")
      .replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)]*\)/g, "$1") // [text](url) → text
      .replace(/\(\s*(?:https?:\/\/|www\.)[^)]*\)/gi, "")
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
      .replace(/\(\s*(?:source|sources|via)\b[^)]*\)/gi, "")
      .replace(/\*\*|__|`+/g, "")
      .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|[.,;:!?]|$)/g, "$1$2")
      .replace(/^\s*(?:[-*•]+|\d+[.)])\s+/, "")
      .replace(/^#+\s*/, "")
      // Prices: a model's dollar figures are guesses and Atlas never posts unchecked money.
      .replace(/\(\s*[^()]*\$\s?\d[^()]*\)/g, "")
      // …and a clause that quotes a price goes whole ("tickets from $45" leaves nothing useful).
      .replace(/(^|[,;—–])[^,;—–]*\$\s?\d[^,;—–]*/g, "")
      .replace(/(?:,|;|—|–|-)?\s*(?:about|around|from|only|just|roughly|~)?\s*\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:-|–|to)\s?\$?\s?\d[\d,]*(?:\.\d+)?)?(?:\s?(?:\+|per\s+\w+|\/\s?\w+|a\s+(?:person|night|day|ticket)|each|pp))?/gi, "")
      .replace(/\b(?:usd|dollars?)\b/gi, "")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([,;:—–-])\s*(?=[,;.]|$)/g, "")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

const DANGLING = /[\s,;:—–-]+(?:and|or|with|the|a|an|to|of|for|from|in|on|at|by|your|its|their|great|high|best|top|some|more|most|very)?\s*$/i;

/** Keep a line under the limit, cutting at a word boundary and never ending on a connector. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  cut = space > max * 0.6 ? cut.slice(0, space) : cut.slice(0, max);
  for (let i = 0; i < 4 && DANGLING.test(cut); i++) cut = cut.replace(DANGLING, "");
  return cut.replace(/[\s,;:—–-]+$/, "");
}

/**
 * Fit a detail into `room` characters: whole when it fits, else the longest leading clause (cut at
 * a comma, dash, "and", "with"...) that fits, else word-clipped. "" when even that is too short.
 */
export function fitDetail(detail: string, room: number): string {
  if (detail.length <= room) return detail;
  const breaks = [...detail.matchAll(/,|;| — | – | - | and | with | plus | or | for | while /g)].map((m) => m.index!).filter((i) => i > 0 && i <= room);
  if (breaks.length) {
    const clause = detail.slice(0, breaks[breaks.length - 1]).trim();
    if (clause.length >= 12) return clause;
  }
  const clipped = clip(detail, room);
  return clipped.length >= 12 ? clipped : "";
}

const tidy = (s: string) => stripArtifacts(s).toLowerCase().replace(/[.;,]+$/, "").trim();

/** One numbered line: "name — detail", lowercase, within MAX_ITEM_CHARS (number included). */
export function formatItem(item: ListItem, n: number): string | null {
  const prefix = `${n}. `;
  const name = clip(tidy(item.name).replace(/:$/, "").replace(/\s*\([^)]*\)\s*/g, " ").trim(), 45);
  if (!name) return null;
  let detail = item.detail ? tidy(item.detail) : "";
  // Small models sometimes repeat the name at the start of the detail.
  if (detail.startsWith(name)) detail = detail.slice(name.length).replace(/^[\s:,—–-]+/, "");
  // A whole thought a few characters over beats a clipped one ("…through scenic winter").
  const room = MAX_ITEM_CHARS - prefix.length - name.length - 3;
  detail = detail.length <= room + ITEM_SLACK ? detail : fitDetail(detail, room);
  return detail ? `${prefix}${name} — ${detail}` : `${prefix}${name}`;
}

/** A heading like "top things to do in gatlinburg in december:"; lowercase, one line, ends with ":". */
export function formatHeading(heading: string): string {
  const h = clip(tidy(heading).replace(/[:.!]+$/, "").replace(/\s+/g, " "), 70);
  return h ? `${h}:` : "here's what i found:";
}

/** The bubble, or null when fewer than MIN_ITEMS usable items survive cleanup. */
export function formatList(heading: string, items: ListItem[]): string | null {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of items) {
    const key = tidy(item.name ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const line = formatItem(item, lines.length + 1);
    if (line) lines.push(line);
    if (lines.length >= MAX_ITEMS) break;
  }
  if (lines.length < MIN_ITEMS) return null;
  return [formatHeading(heading), ...lines].join("\n");
}

/** A short factual answer for the agent (not posted): one or two sentences, no artifacts. */
export function cleanAnswer(text: string, max = 400): string {
  return clip(stripArtifacts(text).replace(/\s*\n+\s*/g, " "), max);
}

const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "2026-12-16" → "dec 16". */
export function shortDate(iso: string): string {
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return MONTH_ABBR[m - 1] ? `${MONTH_ABBR[m - 1]} ${d}` : iso;
}

/** "dec 16–23", "dec 30 – jan 2", "dec 16". */
export function rangeLabel(start: string, end?: string | null): string {
  if (!end || end === start) return shortDate(start);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${shortDate(start)}–${Number(end.slice(8, 10))}`;
  return `${shortDate(start)} – ${shortDate(end)}`;
}

/** The dietary ask in a question, as a heading word: "veggie-friendly", "vegan-friendly"... */
export function dietLabel(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bvegan\b/.test(t)) return "vegan-friendly";
  if (/\b(vegetarian|veggie|plant[- ]based|meatless)\b/.test(t)) return "veggie-friendly";
  if (/\b(gluten[- ]free|celiac|coeliac)\b/.test(t)) return "gluten-free-friendly";
  if (/\bhalal\b/.test(t)) return "halal";
  if (/\bkosher\b/.test(t)) return "kosher";
  return null;
}
