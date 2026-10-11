// Catalog-based per-person trip cost estimate: transport (flight band midpoint or gas share),
// lodging, food, activities and local transport, each labelled with where its number came from.
import { airportByIata, resolveHome, ORIGIN_REGIONS, type Destination, type OriginRegion, type Tier } from "./catalog.ts";

export type CostComponent = "transport" | "lodging" | "food" | "activities" | "local";

export interface CostSource {
  kind: "estimate" | "live";
  detail: string;
  checkedAt?: string;
}

export interface CostBreakdown {
  transportCents: number;
  transportMode: "flight" | "drive";
  /** One-way door-to-door hours for this person (drive or flight). */
  transportHours?: number;
  lodgingCents: number;
  foodCents: number;
  activitiesCents: number;
  localCents: number;
  totalCents: number;
  sources: Record<CostComponent, CostSource>;
}

export interface EstimateMember {
  homeRegion?: string;
  homeAirport?: string;
  noFlying?: boolean;
  /** Longest one-way drive this person will do instead of flying. */
  maxDriveHours?: number;
}

/** Below this many one-way hours, people drive even if they could fly (a 3–5 night trip). */
export const DRIVE_PREFERRED_HOURS = 6.5;
/** Road miles per straight-line mile, and average highway speed, for drive estimates from home. */
export const ROAD_FACTOR = 1.15;
export const ROAD_MPH = 63;
/** Getting out of town and stops, added to every drive. */
export const DRIVE_OVERHEAD_HOURS = 0.25;
/** Longer than this one way isn't a drive anyone would plan. */
export const MAX_REASONABLE_DRIVE_HOURS = 14;
/** Places you can reach by road from the mainland US. */
const DRIVABLE_COUNTRIES = new Set(["United States", "Canada"]);
export const DRIVE_MPH = 60;
export const GAS_CENTS_PER_MILE = 18;
export const MAX_PER_CAR = 4;
/** Unknown origins borrow the southeast band, padded for the uncertainty. */
export const UNKNOWN_ORIGIN_MARKUP = 1.1;
export const DEFAULT_ORIGIN: OriginRegion = "southeast_us";

const REGION_LABEL: Record<OriginRegion, string> = {
  southeast_us: "the southeast",
  northeast_us: "the northeast",
  midwest_us: "the midwest",
  south_central_us: "the south-central US",
  mountain_us: "the mountain west",
  west_us: "the west coast",
};

function isOriginRegion(value: string | undefined): value is OriginRegion {
  return value !== undefined && (ORIGIN_REGIONS as readonly string[]).includes(value);
}

/** The member's origin region: explicit, else from their home airport (IATA or city), else unknown. */
export function memberRegion(member: { homeRegion?: string; homeAirport?: string }): OriginRegion | undefined {
  if (isOriginRegion(member.homeRegion)) return member.homeRegion;
  const suffixed = member.homeRegion ? `${member.homeRegion}_us` : undefined;
  if (isOriginRegion(suffixed)) return suffixed;
  if (member.homeAirport) {
    const airport = airportByIata(member.homeAirport) ?? resolveHome(member.homeAirport);
    if (airport) return airport.region;
  }
  return undefined;
}

function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/** How long a drive people will happily do instead of flying, by trip length. */
export function preferredDriveHours(nights?: number): number {
  if (nights === undefined) return DRIVE_PREFERRED_HOURS;
  if (nights <= 2) return 5;
  if (nights <= 5) return DRIVE_PREFERRED_HOURS;
  return 7.5;
}

export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

function homeAirportOf(member: { homeAirport?: string }) {
  const home = member.homeAirport?.trim();
  return home ? (airportByIata(home) ?? resolveHome(home)) : undefined;
}

/**
 * One-way driving hours from this member's home to the destination: from coordinates when we
 * know their home (Charlotte→Gatlinburg ≈ 3h, Baltimore→Asheville ≈ 8h), else the catalog's
 * coarse per-region figure. Undefined when there's no reasonable road trip (islands, abroad).
 */
export function driveHoursFor(dest: Destination, member: { homeRegion?: string; homeAirport?: string; noFlying?: boolean }): number | undefined {
  const home = homeAirportOf(member);
  if (home && Number.isFinite(home.lat) && Number.isFinite(home.lon)) {
    if (!DRIVABLE_COUNTRIES.has(dest.country) || dest.region === "hawaii") return undefined;
    const miles = haversineMiles(home.lat, home.lon, dest.lat, dest.lon) * ROAD_FACTOR;
    const hours = Math.max(0.5, Math.round((miles / ROAD_MPH + DRIVE_OVERHEAD_HOURS) * 2) / 2);
    if (miles < 20) return 0.5;
    return hours <= MAX_REASONABLE_DRIVE_HOURS ? hours : undefined;
  }
  const region = memberRegion(member) ?? (member.noFlying ? DEFAULT_ORIGIN : undefined);
  return region ? dest.driveFromRegion?.[region] : undefined;
}

/** Gas share per person for a round trip of `hours` each way. */
export function driveShareCents(hours: number, groupSize: number): number {
  const perCar = Math.min(Math.max(1, groupSize), MAX_PER_CAR);
  return Math.round((hours * DRIVE_MPH * GAS_CENTS_PER_MILE * 2) / perCar);
}

/** How this member gets there: drive when it's short for the trip length, they won't fly, or no flight band exists. */
export function travelPlan(
  dest: Destination,
  member: EstimateMember,
  nights?: number,
): { mode: "drive" | "flight"; hours: number; region: OriginRegion; known: boolean } {
  const found = memberRegion(member);
  const region = found ?? DEFAULT_ORIGIN;
  const known = found !== undefined;
  const driveHours = driveHoursFor(dest, member);
  // Someone who can't fly always drives; the hard filter decides whether that's too far.
  if (member.noFlying) return { mode: "drive", hours: driveHours ?? dest.driveFromRegion?.[region] ?? MAX_REASONABLE_DRIVE_HOURS, region, known };
  const band = dest.flightFromRegion[region];
  if (driveHours !== undefined) {
    const comfortable = Math.min(preferredDriveHours(nights), member.maxDriveHours ?? Number.POSITIVE_INFINITY);
    if (!band || driveHours <= comfortable) return { mode: "drive", hours: driveHours, region, known };
  }
  // Unknown origin: a flyer is assumed to fly from the southeast.
  return { mode: "flight", hours: band?.hours ?? dest.flightFromRegion[DEFAULT_ORIGIN]?.hours ?? 0, region, known };
}

export function estimateCost(dest: Destination, member: EstimateMember, nights: number, tier: Tier, groupSize: number): CostBreakdown {
  const n = Math.max(0, Math.round(nights));
  const days = n + 1;
  const c = dest.costs;
  const plan = travelPlan(dest, member, n);

  let transportCents: number;
  let transportDetail: string;
  if (plan.mode === "drive") {
    transportCents = driveShareCents(plan.hours, groupSize);
    const perCar = Math.min(Math.max(1, groupSize), MAX_PER_CAR);
    const from = plan.known ? REGION_LABEL[plan.region] : "the southeast (assumed)";
    transportDetail = `gas share: ${plan.hours}h drive each way from ${from}, split ${perCar} ways`;
  } else {
    const band = dest.flightFromRegion[plan.region] ?? dest.flightFromRegion[DEFAULT_ORIGIN];
    const [low, high] = band?.roundTripCents ?? [0, 0];
    const midpoint = (low + high) / 2;
    if (plan.known && dest.flightFromRegion[plan.region]) {
      transportCents = Math.round(midpoint);
      transportDetail = `round-trip flight from ${REGION_LABEL[plan.region]}, typical ${dollars(low)}–${dollars(high)}`;
    } else {
      transportCents = Math.round(midpoint * UNKNOWN_ORIGIN_MARKUP);
      transportDetail = "assumed flying from the southeast";
    }
  }

  const lodgingCents = c.lodgingPerNightCents[tier] * n;
  const foodCents = c.foodPerDayCents[tier] * days;
  const activitiesCents = c.activitiesPerDayCents[tier] * days;
  const localCents = c.localTransportPerDayCents * days;

  return {
    transportCents,
    transportMode: plan.mode,
    transportHours: plan.hours,
    lodgingCents,
    foodCents,
    activitiesCents,
    localCents,
    totalCents: transportCents + lodgingCents + foodCents + activitiesCents + localCents,
    sources: {
      transport: { kind: "estimate", detail: transportDetail },
      lodging: { kind: "estimate", detail: `${tier} lodging share, ${dollars(c.lodgingPerNightCents[tier])}/night × ${n} nights` },
      food: { kind: "estimate", detail: `${tier} food, ${dollars(c.foodPerDayCents[tier])}/day × ${days} days` },
      activities: { kind: "estimate", detail: `${tier} activities, ${dollars(c.activitiesPerDayCents[tier])}/day × ${days} days` },
      local: { kind: "estimate", detail: `local transport, ${dollars(c.localTransportPerDayCents)}/day × ${days} days` },
    },
  };
}

/** Recompute the total after a component was replaced (e.g. by a live price). */
export function withTotal(b: Omit<CostBreakdown, "totalCents"> & { totalCents?: number }): CostBreakdown {
  return { ...b, totalCents: b.transportCents + b.lodgingCents + b.foodCents + b.activitiesCents + b.localCents };
}
