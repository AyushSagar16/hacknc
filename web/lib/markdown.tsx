// A small Markdown subset for research notes (model output): headings, bullet and numbered
// lists, paragraphs, **bold**, *italic* and [links](https://…). Renders React elements only —
// never raw HTML — and only http(s) links.
import type { ReactNode } from "react";

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string, key: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={k}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={k}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const href = link[2]!;
      return /^https?:\/\//.test(href) ? (
        <a key={k} href={href} rel="noopener noreferrer nofollow" target="_blank">
          {link[1]}
        </a>
      ) : (
        link[1]
      );
    }
    return part;
  });
}

type Block = { kind: "p"; lines: string[] } | { kind: "h"; text: string } | { kind: "ul" | "ol"; items: string[] };

export function Markdown({ source }: { source: string }) {
  const blocks: Block[] = [];
  for (const raw of source.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const last = blocks.at(-1);
    if (!line) {
      blocks.push({ kind: "p", lines: [] });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (heading) blocks.push({ kind: "h", text: heading[1]! });
    else if (bullet) last?.kind === "ul" ? last.items.push(bullet[1]!) : blocks.push({ kind: "ul", items: [bullet[1]!] });
    else if (numbered) last?.kind === "ol" ? last.items.push(numbered[1]!) : blocks.push({ kind: "ol", items: [numbered[1]!] });
    else if (last?.kind === "p") last.lines.push(line);
    else blocks.push({ kind: "p", lines: [line] });
  }
  return (
    <>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        if (b.kind === "h") return <h4 key={k}>{inline(b.text, k)}</h4>;
        if (b.kind === "ul") return <ul key={k}>{b.items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}`)}</li>)}</ul>;
        if (b.kind === "ol") return <ol key={k}>{b.items.map((t, j) => <li key={j}>{inline(t, `${k}-${j}`)}</li>)}</ol>;
        if (b.kind !== "p") return null;
        return b.lines.length ? <p key={k}>{inline(b.lines.join(" "), k)}</p> : null;
      })}
    </>
  );
}

/** Markdown down to plain text, for previews. */
export function plainText(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*#_`>]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
