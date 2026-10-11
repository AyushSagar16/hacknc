// Grounding check for lookups: an item may only be posted if its name is actually written in a
// page we read or a search result snippet. Small models invent plausible places ("ole smoky vegan
// deli"); this is what keeps them out of the chat.

const GENERIC = new Set(["the", "and", "of", "at", "in", "on", "a", "an", "&", "restaurant", "cafe", "café", "bar", "grill", "kitchen", "bistro", "eatery", "co", "company", "shop", "house"]);

/** Lowercase, accents and punctuation gone, "&" read as "and", single spaces. */
export function norm(s: string): string {
  return ` ${s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

/**
 * Does `name` appear in `corpus` (already passed through norm)? Either verbatim, or every
 * distinctive word of it close together (within a name's length or 30 chars), which forgives "the" and word order
 * shuffles like "market square farmers market" vs "farmers market at market square".
 */
export function appearsIn(name: string, corpus: string): boolean {
  const n = norm(name).replace(/^ the /, " ");
  if (n.trim().length < 3) return false;
  if (corpus.includes(n)) return true;
  const words = n.trim().split(" ").filter((w) => w.length >= 3 && !GENERIC.has(w));
  if (words.length === 0) return false;
  if (words.length === 1) return corpus.includes(` ${words[0]} `);
  // Anchor on the rarest word, then require the rest nearby.
  const counts = words.map((w) => corpus.split(` ${w} `).length - 1);
  if (counts.some((c) => c === 0)) return false;
  const anchor = words[counts.indexOf(Math.min(...counts))]!;
  for (let i = corpus.indexOf(` ${anchor} `); i >= 0; i = corpus.indexOf(` ${anchor} `, i + 1)) {
    const reach = Math.max(30, n.length);
    const window = corpus.slice(Math.max(0, i - reach), i + anchor.length + reach);
    if (words.every((w) => window.includes(` ${w} `))) return true;
  }
  return false;
}

export interface SourceText {
  url: string;
  text: string;
}

/**
 * Keep the items whose names appear in the sources, and pick the link to post: the source that
 * names the most kept items (at least two, or the only kept item), else none.
 */
export function groundItems<T extends { name: string }>(items: T[], sources: SourceText[]): { kept: T[]; dropped: T[]; bestUrl?: string } {
  const corpora = sources.map((s) => ({ url: s.url, text: norm(s.text) }));
  const all = corpora.map((c) => c.text).join(" ");
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const it of items) (appearsIn(it.name, all) ? kept : dropped).push(it);
  let bestUrl: string | undefined;
  let best = 0;
  for (const c of corpora) {
    const hits = kept.filter((it) => appearsIn(it.name, c.text)).length;
    if (hits > best) {
      best = hits;
      bestUrl = c.url;
    }
  }
  if (best < Math.min(2, kept.length)) bestUrl = undefined;
  return { kept, dropped, ...(bestUrl ? { bestUrl } : {}) };
}
