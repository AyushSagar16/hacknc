// Keyless web search for the web_search tool. Google Search grounding needs a paid Gemini tier
// (free keys get an instant 429), so the default path is: DuckDuckGo's HTML results page for
// real URLs and snippets, then Gemini's urlContext tool reads the best pages. Every network call
// is injected (tests pass a fake fetch) and bounded by a short timeout; nothing here throws on
// a bad page, it just returns fewer results.

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export type Fetch = typeof fetch;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (ENTITIES[k]) return ENTITIES[k]!;
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)));
    return m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** DuckDuckGo wraps every result in /l/?uddg=<real url>; unwrap it. Ads (y.js) are dropped. */
export function unwrapDdg(href: string): string | null {
  const h = decodeEntities(href).replace(/^\/\//, "https://");
  try {
    const u = new URL(h, "https://duckduckgo.com");
    if (u.hostname.endsWith("duckduckgo.com")) {
      if (u.pathname.startsWith("/y.js")) return null;
      const real = u.searchParams.get("uddg");
      return real && /^https?:\/\//.test(real) ? real : null;
    }
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Parse html.duckduckgo.com results (title link, then snippet). */
export function parseDdgHtml(html: string, limit = 6): WebResult[] {
  const out: WebResult[] = [];
  const seen = new Set<string>();
  const blocks = html.split(/class="result results_links/).slice(1);
  for (const block of blocks) {
    if (/result--ad\b/.test(block.slice(0, 200))) continue;
    const a = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = unwrapDdg(a[1]!);
    if (!url || seen.has(url)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    seen.add(url);
    out.push({ title: stripTags(a[2]!), url, snippet: snippet ? stripTags(snippet[1]!) : "" });
    if (out.length >= limit) break;
  }
  return out;
}

/** Search the web without a key. Returns [] when blocked (a challenge page) or offline. */
export async function ddgSearch(query: string, opts: { fetch?: Fetch; timeoutMs?: number; limit?: number } = {}): Promise<WebResult[]> {
  const f = opts.fetch ?? globalThis.fetch;
  const res = await f(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`, {
    headers: { "user-agent": UA, accept: "text/html" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 4_000),
  });
  if (!res.ok) throw new Error(`search returned ${res.status}`);
  return parseDdgHtml(await res.text(), opts.limit ?? 6);
}

export const isGroundingRedirect = (url: string): boolean => /^https?:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//.test(url);

/**
 * Grounding chunks link through vertexaisearch redirects that mean nothing to a person and expire.
 * Follow one hop to the real page; null (omit the link) if that doesn't work quickly.
 */
export async function resolveRedirect(url: string, opts: { fetch?: Fetch; timeoutMs?: number } = {}): Promise<string | null> {
  if (!isGroundingRedirect(url)) return url;
  const f = opts.fetch ?? globalThis.fetch;
  try {
    const res = await f(url, { method: "HEAD", redirect: "manual", headers: { "user-agent": UA }, signal: AbortSignal.timeout(opts.timeoutMs ?? 2_500) });
    const loc = res.headers.get("location");
    if (loc && /^https?:\/\//.test(loc) && !isGroundingRedirect(loc)) return loc;
    if (res.url && /^https?:\/\//.test(res.url) && !isGroundingRedirect(res.url)) return res.url;
  } catch {
    // fall through: omit the link
  }
  return null;
}

/** Sites whose pages make poor links in a group chat (search pages, logins, social feeds). */
const POOR_LINK = /(^|\.)((google|bing|duckduckgo)\.com|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|pinterest\.com|reddit\.com|youtube\.com)$/i;

/** A link worth a rich preview: https, a real page (not a homepage of a search engine or feed). */
export function linkable(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || POOR_LINK.test(u.hostname) || isGroundingRedirect(url)) return false;
    return !/\.(pdf|docx?|xlsx?)$/i.test(u.pathname);
  } catch {
    return false;
  }
}
