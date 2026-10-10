// Hard constraints only: a destination either survives every member's dealbreakers or is
// rejected with a plain-language reason naming who it fails. Preferences live in score.ts.
import { destinationKeys, findDestination, normalizeName, normalizeTag, type DietaryNeed, type Destination, type Region } from "./catalog.ts";
import { estimateCost, memberRegion, travelPlan, DEFAULT_ORIGIN, type CostBreakdown } from "./estimate.ts";

export interface MemberConstraints {
  personId: number;
  name: string;
  homeRegion?: string;
  homeAirport?: string;
  budgetCeilingCents?: number;
  dietary: string[];
  /** Destination ids/names, tags ("beach"), regions/countries ("europe"), or "cold"/"hot"/"international". */
  vetoes: string[];
  noFlying?: boolean;
  maxDriveHours?: number;
  maxFlightHours?: number;
  noPassport?: boolean;
  mobility?: "low" | "normal";
}

export interface GroupConstraints {
  members: MemberConstraints[];
  startDate?: string;
  endDate?: string;
  nights: number;
  tier: "budget" | "mid";
}

export interface Rejection {
  destinationId: string;
  reason: string;
  personId?: number;
}

export interface Passed {
  dest: Destination;
  perPerson: Map<number, CostBreakdown>;
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** A non-flyer with no stated limit will drive up to this many hours each way. */
export const DEFAULT_MAX_DRIVE_HOURS = 8;
/** dest.dietary[need] must reach this for a member with that need. */
export const DIETARY_MIN = 0.5;
/** A low-mobility member needs at least this many "easy" activities. */
export const MIN_EASY_ACTIVITIES = 4;

/** Calendar months (1–12) a trip touches, in order. Empty when no dates are known. */
export function tripMonths(startDate?: string, endDate?: string): number[] {
  const start = startDate ?? endDate;
  const end = endDate ?? startDate;
  if (!start || !end) return [];
  const s = /^(\d{4})-(\d{2})-\d{2}$/.exec(start);
  const e = /^(\d{4})-(\d{2})-\d{2}$/.exec(end);
  if (!s || !e) return [];
  let y = Number(s[1]);
  let m = Number(s[2]);
  const endKey = Number(e[1]) * 12 + Number(e[2]);
  const months: number[] = [];
  while (y * 12 + m <= endKey && months.length < 12) {
    months.push(m);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

const DIETARY_SYNONYMS: Record<string, DietaryNeed> = {
  vegetarian: "vegetarian", veggie: "vegetarian", veg: "vegetarian", "no meat": "vegetarian", pescatarian: "vegetarian",
  vegan: "vegan", "plant based": "vegan",
  halal: "halal",
  kosher: "kosher",
  "gluten free": "gluten_free", gluten_free: "gluten_free", gf: "gluten_free", celiac: "gluten_free", coeliac: "gluten_free", "no gluten": "gluten_free",
};

const DIETARY_LABEL: Record<DietaryNeed, string> = {
  vegetarian: "vegetarian", vegan: "vegan", halal: "halal", kosher: "kosher", gluten_free: "gluten-free",
};

/** Map "Gluten-free", "veggie", "celiac" onto a catalog dietary key; undefined if we can't check it. */
export function normalizeDietary(text: string): DietaryNeed | undefined {
  const t = normalizeName(text);
  return DIETARY_SYNONYMS[t] ?? DIETARY_SYNONYMS[t.replace(/ /g, "_")];
}

const REGION_WORDS: Record<string, Region> = {
  europe: "europe", mexico: "mexico", caribbean: "caribbean", canada: "canada",
  "central america": "central_america", "south america": "south_america", "latin america": "central_america",
  "west coast": "west_us", southeast: "southeast_us", "the south": "southeast_us", northeast: "northeast_us",
  "east coast": "northeast_us", midwest: "midwest_us", "mountain west": "mountain_us",
};

const COLD_WORDS = new Set(["cold", "cold places", "cold weather", "freezing", "winter", "snowy", "snow places"]);
const HOT_WORDS = new Set(["hot", "hot places", "hot weather", "heat", "humid", "humidity"]);
const INTL_WORDS = new Set(["international", "abroad", "out of the country", "overseas", "passport", "outside the us", "foreign"]);
const FILLER = /\b(places?|trips?|spots?|towns?|destinations?|stuff|vibes?|anything|any|too much|no)\b/g;

function isDomestic(dest: Destination): boolean {
  return dest.country === "United States" || dest.country === "Puerto Rico";
}

function isCold(dest: Destination, months: number[]): boolean {
  if (months.length === 0) return dest.tags.includes("snow") || Math.abs(dest.lat) >= 55;
  return months.some(
    (m) =>
      dest.badMonthReasons?.[String(m)] === "freezing" ||
      (dest.tags.includes("snow") && (m >= 11 || m <= 4)) ||
      (Math.abs(dest.lat) >= 45 && (m >= 11 || m <= 3)) ||
      (Math.abs(dest.lat) >= 38 && (m === 12 || m <= 2)),
  );
}

function isHot(dest: Destination, months: number[]): boolean {
  const tropical = Math.abs(dest.lat) < 26 && !dest.tags.includes("mountains");
  if (months.length === 0) return tropical;
  return months.some(
    (m) => dest.badMonthReasons?.[String(m)] === "brutal heat" || tropical || (Math.abs(dest.lat) < 33 && m >= 6 && m <= 9),
  );
}

/** What a veto knocks out about this destination ("Cancún", "beach places"), or undefined. */
export function vetoMatch(dest: Destination, veto: string, months: number[] = []): string | undefined {
  const v = normalizeName(veto);
  if (!v) return undefined;
  if (findDestination(veto)?.id === dest.id) return dest.name;
  if (COLD_WORDS.has(v)) return isCold(dest, months) ? "cold places" : undefined;
  if (HOT_WORDS.has(v)) return isHot(dest, months) ? "hot places" : undefined;
  if (INTL_WORDS.has(v) || v.startsWith("international")) return isDomestic(dest) ? undefined : "international trips";
  if (normalizeName(dest.country) === v) return dest.country;
  const region = REGION_WORDS[v] ?? REGION_WORDS[v.replace(/^the /, "")];
  if (region) return dest.region === region ? veto.trim() : undefined;
  const stripped = v.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  const tag = normalizeTag(stripped) ?? normalizeTag(v);
  if (tag && dest.tags.includes(tag)) return `${tag.replace(/_/g, " ")} places`;
  // Raw chatter that slipped through ("cancun is too pricey for me"): a whole-word place name.
  const padded = ` ${v} `;
  if (destinationKeys(dest).some((k) => k.length >= 4 && padded.includes(` ${k} `))) return dest.name;
  return undefined;
}

function seasonReason(dest: Destination, month: number): string {
  const explicit = dest.badMonthReasons?.[String(month)];
  if (explicit) return explicit;
  if (month >= 6 && month <= 11) return "hurricane season";
  if (month >= 11 || month <= 3) return "freezing";
  return "off-season";
}

function roughDollars(cents: number): string {
  return `~$${Math.max(10, Math.round(cents / 1000) * 10).toLocaleString("en-US")}`;
}

export function hardFilter(catalog: Destination[], g: GroupConstraints): { passed: Passed[]; rejected: Rejection[] } {
  const passed: Passed[] = [];
  const rejected: Rejection[] = [];
  const months = tripMonths(g.startDate, g.endDate);
  const groupSize = Math.max(1, g.members.length);

  for (const dest of catalog) {
    const reasons: Rejection[] = [];
    const reject = (reason: string, personId?: number): void => {
      reasons.push(personId === undefined ? { destinationId: dest.id, reason } : { destinationId: dest.id, reason, personId });
    };

    for (const m of g.members) {
      for (const veto of m.vetoes) {
        const what = vetoMatch(dest, veto, months);
        if (what) {
          reject(`${m.name} vetoed ${what}`, m.personId);
          break;
        }
      }
    }

    for (const month of months) {
      if (dest.badMonths.includes(month)) reject(`${seasonReason(dest, month)} in ${MONTH_NAMES[month - 1]}`);
    }

    const perPerson = new Map<number, CostBreakdown>();
    for (const m of g.members) {
      if (m.noPassport && dest.passportRequired) reject(`${m.name} doesn't have a passport`, m.personId);

      if (m.noFlying) {
        // Unknown home: assume the Triangle, same as the cost estimate does.
        const region = memberRegion(m) ?? DEFAULT_ORIGIN;
        const hours = dest.driveFromRegion?.[region];
        const max = m.maxDriveHours ?? DEFAULT_MAX_DRIVE_HOURS;
        if (hours === undefined) reject(`${m.name} can't fly and there's no reasonable drive`, m.personId);
        else if (hours > max) reject(`too far to drive for ${m.name} (~${hours}h, max ${max}h)`, m.personId);
      } else if (m.maxFlightHours !== undefined) {
        const plan = travelPlan(dest, m);
        if (plan.mode === "flight" && plan.hours > m.maxFlightHours) {
          reject(`flight's too long for ${m.name} (~${plan.hours}h, max ${m.maxFlightHours}h)`, m.personId);
        }
      }

      const needs = new Set(m.dietary.map(normalizeDietary).filter((n): n is DietaryNeed => n !== undefined));
      for (const need of needs) {
        if ((dest.dietary[need] ?? 0) < DIETARY_MIN) reject(`not enough ${DIETARY_LABEL[need]} options for ${m.name}`, m.personId);
      }

      if (m.mobility === "low") {
        const easy = dest.activities.filter((a) => a.mobility === "easy").length;
        if (easy < MIN_EASY_ACTIVITIES) reject(`not enough easy-going activities for ${m.name}`, m.personId);
      }

      const cost = estimateCost(dest, m, g.nights, g.tier, groupSize);
      perPerson.set(m.personId, cost);
      if (m.budgetCeilingCents !== undefined && cost.totalCents > m.budgetCeilingCents) {
        reject(`over ${m.name}'s ceiling by ${roughDollars(cost.totalCents - m.budgetCeilingCents)}`, m.personId);
      }
    }

    if (reasons.length > 0) rejected.push(...reasons);
    else passed.push({ dest, perPerson });
  }

  return { passed, rejected };
}
