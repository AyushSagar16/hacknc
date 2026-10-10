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
    for (const mention of parseMoneyMentions(text)) {
      const matches = this.items.filter((f) => close(mention, f.cents));
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
      .map((f) => `${dollars(f.cents)} — ${f.label} (${f.source.split(":")[0]})`);
  }
}

/** Rounded mentions ("$1.2k", "about $600") get more slack than exact ones. */
function close(m: MoneyMention, cents: number): boolean {
  const rounded = /k\b|grand|about|around|~|roughly/i.test(m.raw) || (m.cents % 10_000 === 0 && Math.abs(cents) >= 50_000);
  const tolerance = Math.max(100, Math.abs(cents) * (rounded ? 0.05 : 0.005));
  return Math.abs(Math.abs(m.cents) - Math.abs(cents)) <= tolerance;
}

const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: c % 100 === 0 ? 0 : 2, minimumFractionDigits: c % 100 === 0 ? 0 : 2 })}`;
