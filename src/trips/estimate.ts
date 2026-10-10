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

/** Below this many one-way hours, people drive even if they could fly. */
export const DRIVE_PREFERRED_HOURS = 6;
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

/** Gas share per person for a round trip of `hours` each way. */
export function driveShareCents(hours: number, groupSize: number): number {
  const perCar = Math.min(Math.max(1, groupSize), MAX_PER_CAR);
  return Math.round((hours * DRIVE_MPH * GAS_CENTS_PER_MILE * 2) / perCar);
}

/** How this member gets there: drive when it's short, they won't fly, or no flight band exists. */
export function travelPlan(
  dest: Destination,
  member: EstimateMember,
): { mode: "drive" | "flight"; hours: number; region: OriginRegion; known: boolean } {
  const found = memberRegion(member);
  // Unknown origin: a flyer is assumed to fly from the southeast; a non-flyer to drive from there.
  if (!found && !member.noFlying) {
    return { mode: "flight", hours: dest.flightFromRegion[DEFAULT_ORIGIN]?.hours ?? 0, region: DEFAULT_ORIGIN, known: false };
  }
  const region = found ?? DEFAULT_ORIGIN;
  const known = found !== undefined;
  const driveHours = dest.driveFromRegion?.[region];
  const band = dest.flightFromRegion[region];
  if (driveHours !== undefined) {
    const comfortable = Math.min(DRIVE_PREFERRED_HOURS, member.maxDriveHours ?? DRIVE_PREFERRED_HOURS);
    if (member.noFlying || !band || driveHours <= comfortable) return { mode: "drive", hours: driveHours, region, known };
  }
  return { mode: "flight", hours: band?.hours ?? 0, region, known };
}

export function estimateCost(dest: Destination, member: EstimateMember, nights: number, tier: Tier, groupSize: number): CostBreakdown {
  const n = Math.max(0, Math.round(nights));
  const days = n + 1;
  const c = dest.costs;
  const plan = travelPlan(dest, member);

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
    if (member.noFlying) transportDetail += " (no drive route on file)";
  }

  const lodgingCents = c.lodgingPerNightCents[tier] * n;
  const foodCents = c.foodPerDayCents[tier] * days;
  const activitiesCents = c.activitiesPerDayCents[tier] * days;
  const localCents = c.localTransportPerDayCents * days;

  return {
    transportCents,
    transportMode: plan.mode,
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
