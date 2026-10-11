// One trip-page link per reply. A turn can produce several (a tool's link plus the model pasting
// the page into its own words, or the trip page next to the chat's hub page), and iMessage shows a
// preview card for each, so the group sees the same site twice. The last link action to the site
// wins; when there is one, site URLs typed into the text go; otherwise only the first typed one
// stays. Bank-connect links (/connect/…) are personal and never touched.
import type { Action } from "../transport/outbound.ts";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Trip pages and the chat hub on the site: base/t/… and base/g/…, with any query string. */
export function sitePagePattern(baseUrl: string): RegExp {
  const base = escape(baseUrl.replace(/\/+$/, "")).replace(/^https?:/, "https?:");
  return new RegExp(`${base}/(?:t|g)/[^\\s)>\\]]+`, "gi");
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trimEnd())
    .filter((l, i, all) => l.trim() || (i > 0 && all[i - 1]!.trim()))
    .join("\n")
    .trim();
}

export function oneSiteLink(actions: Action[], baseUrl: string | undefined): Action[] {
  if (!baseUrl) return actions;
  const pattern = sitePagePattern(baseUrl);
  const isSite = (url: string) => new RegExp(`^${pattern.source}$`, "i").test(url);
  const lastLink = actions.map((a, i) => (a.type === "link" && isSite(a.url) ? i : -1)).filter((i) => i >= 0).at(-1);
  let typedKept = lastLink !== undefined;
  const out: Action[] = [];
  for (const [i, a] of actions.entries()) {
    if (a.type === "link" && isSite(a.url)) {
      if (i === lastLink) out.push(a);
      continue;
    }
    if (a.type !== "say") {
      out.push(a);
      continue;
    }
    const text = a.text.replace(pattern, (url) => {
      if (typedKept) return "";
      typedKept = true;
      return url;
    });
    if (text === a.text) {
      out.push(a);
      continue;
    }
    const cleaned = tidy(text);
    if (cleaned) out.push({ ...a, text: cleaned });
  }
  return out;
}
