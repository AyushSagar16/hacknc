// Plain-language commands, recognized deterministically before any model runs. Commands that
// could be friend-to-friend talk ("stay quiet") need Atlas to be addressed; ones that can only be
// about Atlas ("keep my budget private") work untagged.
import { toCents } from "../money/cents.ts";

export type Command =
  | { kind: "quiet" }
  | { kind: "unquiet" }
  | { kind: "summarize" }
  | { kind: "help" }
  | { kind: "budget_query" }
  | { kind: "budget_private" }
  | { kind: "budget_public" }
  | { kind: "budget_set"; amountCents: number }
  | { kind: "settle_up" }
  | { kind: "balances" }
  | { kind: "propose" };

const QUIET = /\b(stay quiet|be quiet|go quiet|quiet mode|shh+|hush|mute|stop talking|pipe down|chill out|stop (?:chiming|jumping) in|less chatty)\b/i;
const UNQUIET = /\b(you can talk again|talk again|unmute|speak up|you can chime in|chime in again|come back|un-?quiet|you can (?:speak|jump in) again)\b/i;
const SUMMARY = /\b(summari[sz]e|summary|recap|where are we|catch me up|tl;?dr|what('?s| is| did we) (?:the plan|decided?)|status)\b/i;
const HELP = /^\W*(?:\w+\W+)?(?:help|commands)\W*$|\b(what can you do|how do(?:es)? (?:this|you) work)\b/i;
const BUDGET_QUERY = /\b(what('?s| is| are) (?:our|the|everyone'?s?) budgets?|how much (?:can|should) we (?:spend|afford)|what can we afford|budget check)\b/i;
const BUDGET_PRIVATE = /\b(keep|make) my budget private\b|\bdon'?t (?:share|show) my budget\b|\bmy budget(?: is|'s)? private\b/i;
const BUDGET_PUBLIC = /\b(make|set) my budget public\b|\byou can (?:share|show) my budget\b/i;
const BUDGET_SET = /\b(?:set|change|update|put|make) my budget (?:to|at|as)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(k)?\b|\bmy budget is (?:actually )?\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(k)?\b/i;
const SETTLE = /\b(settle up|settle (?:things|everything)|let'?s settle|square up|split (?:it|everything) up now)\b/i;
const BALANCES = /\b(who owes (?:who|whom|what|me)|what do i owe|how much do i owe|balances?)\b/i;
const PROPOSE = /\b(give us|show us|send|pitch|propose|suggest)\b.*\b(options|ideas|destinations|places|spots)\b/i;

export function parseCommand(text: string, ctx: { addressed: boolean }): Command | null {
  const t = text.trim();
  if (BUDGET_PRIVATE.test(t)) return { kind: "budget_private" };
  if (BUDGET_PUBLIC.test(t)) return { kind: "budget_public" };
  const set = BUDGET_SET.exec(t);
  if (set) {
    const raw = (set[1] ?? set[3] ?? "").replace(/,/g, "");
    const k = Boolean(set[2] ?? set[4]);
    try {
      const cents = toCents(raw) * (k ? 1000 : 1);
      if (cents > 0) return { kind: "budget_set", amountCents: cents };
    } catch {
      // not a clean amount; let the agent read it
    }
  }
  if (BUDGET_QUERY.test(t)) return { kind: "budget_query" };
  if (SETTLE.test(t)) return { kind: "settle_up" };
  if (!ctx.addressed) return null;
  if (UNQUIET.test(t)) return { kind: "unquiet" };
  if (QUIET.test(t)) return { kind: "quiet" };
  if (BALANCES.test(t)) return { kind: "balances" };
  if (PROPOSE.test(t)) return { kind: "propose" };
  if (SUMMARY.test(t)) return { kind: "summarize" };
  if (HELP.test(t)) return { kind: "help" };
  return null;
}
