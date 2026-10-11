// Soft scoring of destinations that survived the hard filter, plus picking a diverse top three
// for the group poll. Every point is explainable: reasons say who it's for and why.
import { destinationKeys, findDestination, isSettingTag, normalizeName, normalizeTag, type Destination, type Tag } from "./catalog.ts";
import type { CostBreakdown } from "./estimate.ts";
import { hasTag, MONTH_NAMES, tripMonths, type GroupConstraints, type Passed } from "./filter.ts";

export interface MemberPrefs {
  personId: number;
  likesTags: string[];
  /** Places they said they want to go. */
  namedDestinations: string[];
  dislikesTags: string[];
}

export interface Scored {
  dest: Destination;
  score: number;
  reasons: string[];
  perPerson: Map<number, CostBreakdown>;
}

export const WEIGHTS = {
  named: 3,
  like: 1,
  dislike: -1.5,
  bestMonth: 1,
  /** Max bonus for the tightest budget margin (0..1 of the ceiling). */
  headroom: 1,
  /** Penalty per $1,000 of average per-person cost. */
  costPer1000: 0.5,
  maxCostPenalty: 1.5,
  /** Penalty per one-way travel hour beyond FREE_TRAVEL_HOURS (halved-ish for long trips). */
  travelPerHour: 0.4,
  maxTravelPenalty: 1.5,
} as const;

/** One-way hours nobody minds. */
export const FREE_TRAVEL_HOURS = 3;
/** Getting to the airport, security, bags: what a flight costs on top of its air time. */
export const FLIGHT_OVERHEAD_HOURS = 2;

/** A replacement must score within this fraction of the option it displaces. */
export const DIVERSITY_WINDOW = 0.15;
export const CHEAPER_WINDOW = 0.25;

export function averageCostCents(s: { perPerson: Map<number, CostBreakdown> }): number {
  if (s.perPerson.size === 0) return 0;
  let sum = 0;
  for (const b of s.perPerson.values()) sum += b.totalCents;
  return sum / s.perPerson.size;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "someone";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function tagLabel(tag: Tag): string {
  return tag.replace(/_/g, " ");
}

function compareScored(a: Scored, b: Scored): number {
  return b.score - a.score || averageCostCents(a) - averageCostCents(b) || a.dest.id.localeCompare(b.dest.id);
}

function tagsOf(list: string[]): Tag[] {
  return [...new Set(list.map(normalizeTag).filter((t): t is Tag => t !== undefined))];
}

export function scoreDestinations(passed: Passed[], g: GroupConstraints, prefs: MemberPrefs[], month?: number): Scored[] {
  const names = new Map(g.members.map((m) => [m.personId, m.name]));
  const nameOf = (id: number): string => names.get(id) ?? "someone";
  const months = month !== undefined ? [month] : tripMonths(g.startDate, g.endDate);
  const tripMonth = months[0];
  const ceilings = g.members.filter((m) => m.budgetCeilingCents !== undefined && m.budgetCeilingCents > 0);

  const prepared = prefs.map((p) => ({
    personId: p.personId,
    likes: tagsOf(p.likesTags),
    dislikes: tagsOf(p.dislikesTags),
    named: p.namedDestinations,
  }));
  const namedIt = (said: string[], dest: Destination): boolean => {
    const keys = destinationKeys(dest);
    return said.some((n) => findDestination(n)?.id === dest.id || keys.includes(normalizeName(n)));
  };

  const scored = passed.map(({ dest, perPerson }): Scored => {
    let score = 0;
    const reasons: string[] = [];
    const negatives: string[] = [];

    const namers = prepared.filter((p) => namedIt(p.named, dest)).map((p) => nameOf(p.personId));
    if (namers.length > 0) {
      score += WEIGHTS.named * namers.length;
      reasons.push(`${joinNames(namers)} named it`);
    }

    const likedBy = new Map<Tag, string[]>();
    const dislikedBy = new Map<Tag, string[]>();
    for (const p of prepared) {
      for (const tag of p.likes) {
        if (!hasTag(dest, tag, months) || p.dislikes.includes(tag)) continue;
        score += WEIGHTS.like;
        likedBy.set(tag, [...(likedBy.get(tag) ?? []), nameOf(p.personId)]);
      }
      for (const tag of p.dislikes) {
        if (!dest.tags.includes(tag)) continue;
        score += WEIGHTS.dislike;
        dislikedBy.set(tag, [...(dislikedBy.get(tag) ?? []), nameOf(p.personId)]);
      }
    }
    const byCount = <T>(m: Map<Tag, T[]>): [Tag, T[]][] =>
      [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    // One reason per set of people: "city and mountains for ana", never "city for ana, mountains for ana".
    const byWho = new Map<string, { tags: Tag[]; who: string[] }>();
    for (const [tag, who] of byCount(likedBy)) {
      const key = [...who].sort().join("|");
      const entry = byWho.get(key) ?? { tags: [], who };
      entry.tags.push(tag);
      byWho.set(key, entry);
    }
    for (const { tags, who } of byWho.values()) reasons.push(`${joinNames(tags.map(tagLabel))} for ${joinNames(who)}`);
    for (const [tag, who] of byCount(dislikedBy)) negatives.push(`${joinNames(who)} ${who.length > 1 ? "aren't" : "isn't"} into ${tagLabel(tag)}`);

    if (tripMonth !== undefined && dest.bestMonths.includes(tripMonth)) {
      score += WEIGHTS.bestMonth;
      reasons.push(`great in ${MONTH_NAMES[tripMonth - 1]}`);
    }

    if (ceilings.length > 0) {
      let minMargin = 1;
      for (const m of ceilings) {
        const total = perPerson.get(m.personId)?.totalCents;
        if (total === undefined) continue;
        minMargin = Math.min(minMargin, (m.budgetCeilingCents! - total) / m.budgetCeilingCents!);
      }
      const bonus = Math.max(0, Math.min(1, minMargin));
      score += WEIGHTS.headroom * bonus;
      if (bonus >= 0.3) reasons.push("comfortably under everyone's budget");
    }

    const avg = averageCostCents({ perPerson });
    score -= Math.min(WEIGHTS.maxCostPenalty, (avg / 100_000) * WEIGHTS.costPer1000);

    // Closer is better for a short trip: a long weekend from NC shouldn't default to Medellín.
    const hours = [...perPerson.values()]
      .filter((c) => typeof c.transportHours === "number")
      .map((c) => c.transportHours! + (c.transportMode === "flight" ? FLIGHT_OVERHEAD_HOURS : 0));
    if (hours.length > 0) {
      const avgHours = hours.reduce((a, b) => a + b, 0) / hours.length;
      const shortTrip = g.nights <= 4 ? 1 : 0.6;
      score -= Math.min(WEIGHTS.maxTravelPenalty, Math.max(0, avgHours - FREE_TRAVEL_HOURS) * WEIGHTS.travelPerHour * shortTrip);
    }

    return { dest, score: Math.round(score * 1000) / 1000, reasons: [...reasons, ...negatives], perPerson };
  });

  return scored.sort(compareScored);
}

function withinWindow(candidate: Scored, reference: Scored, window: number): boolean {
  return candidate.score >= reference.score - window * Math.abs(reference.score);
}

function medianCost(list: Scored[]): number {
  const costs = list.map(averageCostCents).sort((a, b) => a - b);
  if (costs.length === 0) return 0;
  const mid = Math.floor(costs.length / 2);
  return costs.length % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2;
}

function triplesRegion(picks: Scored[], candidate: Scored): boolean {
  return picks.length === 2 && picks.every((p) => p.dest.region === candidate.dest.region);
}

/**
 * Top three for the poll. Avoids three from one region when a different-region option scores
 * within 15% of the one it would replace, and swaps in a cheaper option (at or under the median
 * cost) when none of the three is and one scores within 25% of the third pick.
 */
export function pickThree(scored: Scored[], opts: { cover?: Tag[]; months?: number[] } = {}): Scored[] {
  const sorted = [...scored].sort(compareScored);
  if (sorted.length <= 3) return sorted;
  const picks = pickThreePlain(sorted);
  return coverTags(picks, sorted, opts.cover ?? [], opts.months ?? []).sort(compareScored);
}

/** Make sure each asked-for vibe ("ski or beach") has at least one option, swapping out the weakest spare pick. */
function coverTags(picks: Scored[], sorted: Scored[], cover: Tag[], months: number[]): Scored[] {
  const out = [...picks];
  const tags = [...new Set(cover)];
  if (tags.length < 2) return out;
  for (const tag of tags) {
    if (out.some((p) => hasTag(p.dest, tag, months))) continue;
    const best = sorted.find((s) => !out.includes(s) && hasTag(s.dest, tag, months));
    if (!best) continue;
    // Replace the lowest pick whose vibe is still covered by another pick.
    const covers = (p: Scored) => tags.filter((t) => hasTag(p.dest, t, months));
    const spare = [...out]
      .sort(compareScored)
      .reverse()
      .find((p) => covers(p).every((t) => out.some((o) => o !== p && hasTag(o.dest, t, months))));
    if (spare) out[out.indexOf(spare)] = best;
  }
  return out;
}

function pickThreePlain(sorted: Scored[]): Scored[] {
  const picks: Scored[] = [];
  while (picks.length < 3) {
    const remaining = sorted.filter((s) => !picks.includes(s));
    let next = remaining[0]!;
    if (triplesRegion(picks, next)) {
      const alt = remaining.find((s) => !triplesRegion(picks, s) && withinWindow(s, next, DIVERSITY_WINDOW));
      if (alt) next = alt;
    }
    picks.push(next);
  }

  const median = medianCost(sorted);
  if (!picks.some((p) => averageCostCents(p) <= median)) {
    const third = picks[2]!;
    const firstTwo = picks.slice(0, 2);
    const cheaper = sorted.find(
      (s) => !picks.includes(s) && averageCostCents(s) <= median && withinWindow(s, third, CHEAPER_WINDOW) && !triplesRegion(firstTwo, s),
    );
    if (cheaper) picks[2] = cheaper;
  }

  return picks;
}

// ---------- vibe (the setting the group asked for) ----------

/**
 * The setting(s) the group's likes point to: beach/mountains/snow/city tags somebody likes and
 * nobody dislikes. One setting means "we want a beach trip"; several mean the group is split
 * (cover each with an option). Empty when likes don't point anywhere.
 */
export function inferVibe(prefs: MemberPrefs[]): Tag[] {
  const liked = new Map<Tag, number>();
  const disliked = new Set<Tag>();
  for (const p of prefs) {
    for (const t of tagsOf(p.likesTags)) if (isSettingTag(t)) liked.set(t, (liked.get(t) ?? 0) + 1);
    for (const t of tagsOf(p.dislikesTags)) disliked.add(t);
  }
  return [...liked.entries()]
    .filter(([t]) => !disliked.has(t))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

/** Free-text vibes ("beaches", "christmas markets", ["ski", "beach"]) onto catalog tags. */
export function vibeTags(input: unknown): Tag[] {
  const list = Array.isArray(input) ? input : typeof input === "string" ? input.split(/\s*(?:,|\bor\b|\/|\bvs\.?\b)\s*/i) : [];
  return [...new Set(list.filter((x): x is string => typeof x === "string").map((x) => normalizeTag(x.trim())).filter((t): t is Tag => t !== undefined))];
}

export interface VibeResult {
  /** Candidates to pick from. */
  kept: Scored[];
  /** Vibes with at least one matching candidate (pickThree covers each). */
  covered: Tag[];
  /** Vibes we couldn't honour fully, with how many fit. */
  short: { tag: Tag; count: number }[];
  /** True when only vibe-matching options are left. */
  strict: boolean;
}

/** Require the vibe when at least two candidates have it; otherwise keep everything and report the shortfall. */
export function applyVibe(scored: Scored[], vibes: Tag[], months: number[] = []): VibeResult {
  if (vibes.length === 0) return { kept: scored, covered: [], short: [], strict: false };
  const matching = scored.filter((s) => vibes.some((t) => hasTag(s.dest, t, months)));
  const counts = vibes.map((tag) => ({ tag, count: scored.filter((s) => hasTag(s.dest, tag, months)).length }));
  const covered = counts.filter((c) => c.count > 0).map((c) => c.tag);
  const short = counts.filter((c) => c.count < 2);
  if (matching.length >= 2) return { kept: matching, covered, short: short.filter((c) => c.count === 0), strict: true };
  return { kept: scored, covered, short, strict: false };
}

/** The one reason worth printing under an option ("beach for maya and leo"), or undefined. */
export function bestReason(s: Scored, opts: { groupSize: number; vibe?: Tag[] } = { groupSize: 0 }): string | undefined {
  const named = s.reasons.find((r) => r.endsWith(" named it"));
  if (named) return named;
  const liked = s.reasons.filter((r) => / for /.test(r) && !r.startsWith("great in"));
  // Prefer the reason that names the asked-for vibe, then the one covering the most people.
  const people = (r: string) => r.split(" for ")[1]!.split(/, | and /).length;
  const vibeLabel = (opts.vibe ?? []).map((t) => t.replace(/_/g, " "));
  const ranked = [...liked].sort((a, b) => Number(vibeLabel.some((v) => b.startsWith(v))) - Number(vibeLabel.some((v) => a.startsWith(v))) || people(b) - people(a));
  const top = ranked[0];
  if (top) {
    const [what, who] = top.split(" for ");
    return opts.groupSize > 1 && people(top) >= opts.groupSize ? `${what} for everyone` : `${what} for ${who}`;
  }
  const hours = [...s.perPerson.values()];
  if (hours.length && hours.every((c) => c.transportMode === "drive" && (c.transportHours ?? 99) <= 4)) {
    const max = Math.max(...hours.map((c) => c.transportHours ?? 0));
    return `easy drive, ~${max}h`;
  }
  return s.reasons.find((r) => r === "comfortably under everyone's budget");
}
