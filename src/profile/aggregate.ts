// Deterministic resolution of extracted facts into one profile per person. The model only
// reports what people said; this decides what's true now. Rules:
//   1. facts under the confidence floor are ignored;
//   2. facts compete per slot (e.g. "destination:cancun", "date_window.latest", "dietary:vegan");
//   3. within a slot an explicit statement beats an implied one, and the newest of the
//      strongest kind wins — so a later "actually i can do the 15th" overrides, but a later
//      vague hint doesn't override something said outright;
//   4. a winning neutral or retracting fact clears the slot.
import type { Fact } from "./schema.ts";

export const MIN_CONFIDENCE = 0.6;

export interface Resolved<T> {
  value: T;
  factId: number;
  quote: string | null;
  observedAt: Date;
  confidence: number;
  explicit: boolean;
}

export interface PersonProfile {
  personId: number;
  name?: Resolved<string>;
  homeCity?: Resolved<string>;
  earliest?: Resolved<string>;
  latest?: Resolved<string>;
  blackouts: Resolved<{ start: string; end: string }>[];
  minNights?: Resolved<number>;
  maxNights?: Resolved<number>;
  dietary: Resolved<string>[];
  wants: Resolved<string>[];
  vetoes: Resolved<string>[];
  likes: Resolved<string>[];
  dislikes: Resolved<string>[];
  travelLimits: Resolved<{ kind: string; hours: number | null }>[];
  budgetCeilingUsd?: Resolved<number>;
  tooExpensive: Resolved<string>[];
  budgetMood?: Resolved<"tight" | "flexible">;
}

export function normPlace(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface Claim {
  slot: string;
  fact: Fact;
  /** What the slot becomes if this claim wins; undefined clears it. */
  apply?: (p: PersonProfile, r: Resolved<unknown>) => void;
}

function claimsOf(f: Fact): Claim[] {
  const v = f.value as Record<string, unknown>;
  // Constraint keys assert the constraint by existing, so a retraction clears them; for preference
  // keys the polarity carries the meaning and a retraction is just the newer statement.
  const assertive = f.key === "blackout" || f.key === "dietary" || f.key === "travel_limit";
  const cleared = f.polarity === "neutral" || (assertive && f.retracted);
  const claim = (slot: string, apply?: Claim["apply"]): Claim => ({ slot, fact: f, apply: cleared ? undefined : apply });
  switch (f.key) {
    case "name":
      return [claim("name", (p, r) => (p.name = r as Resolved<string>))];
    case "home_city":
      return [claim("home_city", (p, r) => (p.homeCity = r as Resolved<string>))];
    case "date_window": {
      const out: Claim[] = [];
      if (v.earliest) out.push(claim("date_window.earliest", (p, r) => (p.earliest = r as Resolved<string>)));
      if (v.latest) out.push(claim("date_window.latest", (p, r) => (p.latest = r as Resolved<string>)));
      return out;
    }
    case "blackout":
      return [claim(`blackout:${v.start}:${v.end}`, (p, r) => p.blackouts.push(r as Resolved<{ start: string; end: string }>))];
    case "trip_length": {
      const out: Claim[] = [];
      if (v.minNights) out.push(claim("trip_length.min", (p, r) => (p.minNights = r as Resolved<number>)));
      if (v.maxNights) out.push(claim("trip_length.max", (p, r) => (p.maxNights = r as Resolved<number>)));
      return out;
    }
    case "dietary":
      return [{ slot: `dietary:${v.need}`, fact: f, apply: cleared || f.polarity === "negative" ? undefined : (p, r) => p.dietary.push(r as Resolved<string>) }];
    case "destination": {
      const place = normPlace(String(v.name));
      return [
        claim(`destination:${place}`, (p, r) => (f.polarity === "negative" ? p.vetoes : p.wants).push(r as Resolved<string>)),
      ];
    }
    case "activity":
      return [claim(`activity:${v.tag}`, (p, r) => (f.polarity === "negative" ? p.dislikes : p.likes).push(r as Resolved<string>))];
    case "travel_limit":
      return [
        {
          slot: `travel_limit:${v.kind}`,
          fact: f,
          apply: cleared || f.polarity === "negative" ? undefined : (p, r) => p.travelLimits.push(r as Resolved<{ kind: string; hours: number | null }>),
        },
      ];
    case "budget_comment": {
      const kind = v.kind as string;
      if (kind === "ceiling" && typeof v.amountUsd === "number") return [claim("budget.ceiling", (p, r) => (p.budgetCeilingUsd = r as Resolved<number>))];
      if (kind === "too_expensive" && v.about) return [claim(`budget.too_expensive:${normPlace(String(v.about))}`, (p, r) => p.tooExpensive.push(r as Resolved<string>))];
      if (kind === "tight" || kind === "flexible") return [claim("budget.mood", (p, r) => (p.budgetMood = r as Resolved<"tight" | "flexible">))];
      return [];
    }
  }
}

function valueFor(f: Fact): unknown {
  const v = f.value as Record<string, unknown>;
  switch (f.key) {
    case "name":
      return v.name;
    case "home_city":
      return v.city;
    case "date_window":
      return undefined; // set per sub-slot below
    case "blackout":
      return { start: v.start, end: v.end };
    case "dietary":
      return v.need;
    case "destination":
      return String(v.name);
    case "activity":
      return v.tag;
    case "travel_limit":
      return { kind: v.kind, hours: (v.hours as number | null | undefined) ?? null };
    case "budget_comment":
      return v.kind === "ceiling" ? v.amountUsd : v.kind === "too_expensive" ? String(v.about) : v.kind;
    default:
      return v;
  }
}

/** Stronger claims sort later: implied before explicit, then older before newer. */
function strength(f: Fact): [number, number, number] {
  return [f.explicit ? 1 : 0, f.observedAt.getTime(), f.id];
}

function stronger(a: Fact, b: Fact): boolean {
  const [ae, at, ai] = strength(a);
  const [be, bt, bi] = strength(b);
  return ae !== be ? ae > be : at !== bt ? at > bt : ai > bi;
}

export function aggregate(personId: number, facts: readonly Fact[], minConfidence = MIN_CONFIDENCE): PersonProfile {
  const profile: PersonProfile = {
    personId,
    blackouts: [],
    dietary: [],
    wants: [],
    vetoes: [],
    likes: [],
    dislikes: [],
    travelLimits: [],
    tooExpensive: [],
  };
  const winners = new Map<string, Claim>();
  for (const f of facts) {
    if (f.personId !== personId || f.confidence < minConfidence) continue;
    for (const c of claimsOf(f)) {
      const current = winners.get(c.slot);
      if (!current || stronger(c.fact, current.fact)) winners.set(c.slot, c);
    }
  }
  const ordered = [...winners.values()].sort((a, b) => a.fact.observedAt.getTime() - b.fact.observedAt.getTime() || a.fact.id - b.fact.id);
  for (const c of ordered) {
    if (!c.apply) continue;
    const v = c.fact.value as Record<string, unknown>;
    let value = valueFor(c.fact);
    if (c.slot === "date_window.earliest") value = v.earliest;
    if (c.slot === "date_window.latest") value = v.latest;
    if (c.slot === "trip_length.min") value = v.minNights;
    if (c.slot === "trip_length.max") value = v.maxNights;
    c.apply(profile, {
      value,
      factId: c.fact.id,
      quote: c.fact.quote,
      observedAt: c.fact.observedAt,
      confidence: c.fact.confidence,
      explicit: c.fact.explicit,
    });
  }
  return profile;
}

/** Ids of facts that lost their slot to a later/stronger one, for the audit trail. */
export function supersededFacts(facts: readonly Fact[], minConfidence = MIN_CONFIDENCE): Map<number, number> {
  const winners = new Map<string, Fact>();
  const bySlot = new Map<string, Fact[]>();
  for (const f of facts) {
    if (f.confidence < minConfidence) continue;
    for (const c of claimsOf(f)) {
      const slot = `${f.personId}|${c.slot}`;
      bySlot.set(slot, [...(bySlot.get(slot) ?? []), f]);
      const current = winners.get(slot);
      if (!current || stronger(f, current)) winners.set(slot, f);
    }
  }
  const out = new Map<number, number>();
  for (const [slot, list] of bySlot) {
    const winner = winners.get(slot)!;
    for (const f of list) if (f.id !== winner.id) out.set(f.id, winner.id);
  }
  return out;
}
