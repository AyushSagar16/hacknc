// How each person gets to the trip, once where and when are settled. Deterministic: drive or fly
// comes from estimate.ts (short drives win, no-flyers always drive, "i'll drive" overrides),
// drivers from the same metro (same home airport) are grouped into carpools of up to four and
// split the gas, flyers get a fare (live from SerpApi when available, else the catalog band) and
// a Google Flights link. Travel is each person's own cost, never the shared trip fund.
import { daysBetween } from "../clock.ts";
import { db, q, type Queryable } from "../db/pool.ts";
import { airportByIata, resolveHome, type Airport, type Destination } from "./catalog.ts";
import { DEFAULT_ORIGIN, DRIVE_MPH, driveHoursFor, GAS_CENTS_PER_MILE, haversineMiles, MAX_PER_CAR, memberRegion, travelPlan, UNKNOWN_ORIGIN_MARKUP } from "./estimate.ts";
import { googleFlightsLink } from "./links.ts";
import { flightBandForMiles } from "./place.ts";

export type TravelMode = "drive" | "fly";

export interface TravelMember {
  personId: number;
  name: string;
  /** Where they said they'd leave from ("Raleigh"). */
  origin?: string;
  noFlying?: boolean;
  maxDriveHours?: number;
  /** "i'll drive" / "i'll fly". */
  override?: TravelMode;
}

export interface TravelLeg {
  personId: number;
  name: string;
  mode: TravelMode;
  origin: string | null;
  originIata: string | null;
  /** One-way hours. */
  hours: number | null;
  /** This person's own round-trip cost: their gas share, or a fare. */
  costCents: number | null;
  costSource: "estimate" | "live";
  /** Drivers sharing a car ("rdu-1"); null when driving alone or flying. */
  carpoolGroup: string | null;
  carpoolWith: number[];
  overridden: boolean;
  link: string | null;
  /** Why a plan couldn't be made or the override doesn't work ("no home city", "no road"). */
  problem?: "no_home" | "no_road" | "no_fly";
}

function homeOf(origin: string | undefined): Airport | undefined {
  const o = origin?.trim();
  return o ? (resolveHome(o) ?? airportByIata(o)) : undefined;
}

/** A round trip's gas for one car, `hours` each way. */
export function carGasCents(hours: number): number {
  return Math.round(hours * DRIVE_MPH * GAS_CENTS_PER_MILE * 2);
}

/** Typical round-trip fare from this person's region (midpoint of the band), or from distance. */
export function flightEstimateCents(dest: Destination, home: Airport | undefined): { cents: number; hours: number } {
  const region = memberRegion({ homeAirport: home?.iata });
  const band = (region && dest.flightFromRegion[region]) ?? undefined;
  if (band) return { cents: Math.round((band.roundTripCents[0] + band.roundTripCents[1]) / 2), hours: band.hours };
  if (home) {
    const b = flightBandForMiles(haversineMiles(home.lat, home.lon, dest.lat, dest.lon), Boolean(dest.iata));
    return { cents: Math.round((b.roundTripCents[0] + b.roundTripCents[1]) / 2), hours: b.hours };
  }
  const fallback = dest.flightFromRegion[DEFAULT_ORIGIN] ?? flightBandForMiles(600, Boolean(dest.iata));
  return { cents: Math.round(((fallback.roundTripCents[0] + fallback.roundTripCents[1]) / 2) * UNKNOWN_ORIGIN_MARKUP), hours: fallback.hours };
}

export interface PlanOpts {
  dates: { start: string; end: string };
  /** Live fares by person (from SerpApi); everyone else gets the band estimate. */
  fares?: Map<number, { cents: number }>;
}

/** Everyone's travel, in member order. */
export function planTravel(dest: Destination, members: TravelMember[], opts: PlanOpts): TravelLeg[] {
  const nights = Math.max(1, daysBetween(opts.dates.start, opts.dates.end));
  const flightTarget = dest.iata || dest.name;
  const legs: TravelLeg[] = members.map((m) => {
    const home = homeOf(m.origin);
    const base = { personId: m.personId, name: m.name, origin: m.origin ?? null, originIata: home?.iata ?? null, carpoolGroup: null, carpoolWith: [], overridden: Boolean(m.override), costSource: "estimate" as const, link: null };
    if (!home) {
      return { ...base, mode: m.override ?? (m.noFlying ? "drive" : "fly"), hours: null, costCents: null, problem: "no_home" as const };
    }
    const member = { homeAirport: home.iata, homeRegion: home.region, noFlying: m.noFlying, maxDriveHours: m.maxDriveHours };
    const driveHours = driveHoursFor(dest, member);
    const auto: TravelMode = travelPlan(dest, member, nights).mode === "drive" ? "drive" : "fly";
    let mode: TravelMode = m.override ?? auto;
    let problem: TravelLeg["problem"];
    if (mode === "drive" && driveHours === undefined) {
      // No road there (an island, abroad, or a drive nobody would plan): they fly after all.
      problem = "no_road";
      mode = m.noFlying ? "drive" : "fly";
    }
    if (mode === "fly" && m.noFlying && !m.override) mode = "drive";
    if (mode === "fly" && m.noFlying && m.override === "fly") problem = "no_fly";
    if (mode === "drive") return { ...base, mode, hours: driveHours ?? null, costCents: null, ...(problem ? { problem } : {}) };
    const est = flightEstimateCents(dest, home);
    const live = opts.fares?.get(m.personId);
    const sameAirport = home.iata === dest.iata;
    return {
      ...base,
      mode,
      hours: est.hours,
      costCents: live?.cents ?? est.cents,
      costSource: live ? "live" : "estimate",
      link: sameAirport ? null : googleFlightsLink(home.iata, flightTarget, opts.dates.start, opts.dates.end),
      ...(problem ? { problem } : {}),
    };
  });

  // Carpools: drivers leaving from the same metro (same home airport) share cars of up to four.
  const byMetro = new Map<string, TravelLeg[]>();
  for (const l of legs) if (l.mode === "drive" && l.hours !== null && l.originIata) byMetro.set(l.originIata, [...(byMetro.get(l.originIata) ?? []), l]);
  for (const [metro, drivers] of byMetro) {
    for (let i = 0; i < drivers.length; i += MAX_PER_CAR) {
      const car = drivers.slice(i, i + MAX_PER_CAR);
      const hours = Math.max(...car.map((d) => d.hours ?? 0));
      const share = Math.round(carGasCents(hours) / car.length);
      const group = car.length > 1 ? `${metro.toLowerCase()}-${i / MAX_PER_CAR + 1}` : null;
      for (const d of car) {
        d.costCents = share;
        d.carpoolGroup = group;
        d.carpoolWith = car.filter((x) => x.personId !== d.personId).map((x) => x.personId);
      }
    }
  }
  return legs;
}

// ---------- storage ----------

export interface TravelPlanRow {
  trip_id: number;
  person_id: number;
  mode: TravelMode;
  origin: string | null;
  origin_iata: string | null;
  est_cost_cents: number | null;
  cost_source: "estimate" | "live";
  hours: number | null;
  carpool_group: string | null;
  overridden: boolean;
  link: string | null;
  updated_at: Date;
}

export async function travelPlansFor(tripId: number, on: Queryable = db()): Promise<TravelPlanRow[]> {
  const rows = await q<TravelPlanRow>(`SELECT * FROM travel_plans WHERE trip_id = $1 ORDER BY person_id`, [tripId], on);
  return rows.map((r) => ({ ...r, person_id: Number(r.person_id), est_cost_cents: r.est_cost_cents === null ? null : Number(r.est_cost_cents) }));
}

export async function saveTravelPlans(tripId: number, legs: TravelLeg[], at: Date, on: Queryable = db()): Promise<void> {
  for (const l of legs) {
    await q(
      `INSERT INTO travel_plans (trip_id, person_id, mode, origin, origin_iata, est_cost_cents, cost_source, hours, carpool_group, overridden, link, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (trip_id, person_id) DO UPDATE SET mode = EXCLUDED.mode, origin = EXCLUDED.origin, origin_iata = EXCLUDED.origin_iata,
         est_cost_cents = EXCLUDED.est_cost_cents, cost_source = EXCLUDED.cost_source, hours = EXCLUDED.hours,
         carpool_group = EXCLUDED.carpool_group, overridden = EXCLUDED.overridden, link = EXCLUDED.link, updated_at = EXCLUDED.updated_at`,
      [tripId, l.personId, l.mode, l.origin, l.originIata, l.costCents, l.costSource, l.hours, l.carpoolGroup, l.overridden, l.link, at],
      on,
    );
  }
  // People who left the group drop off the plan.
  await q(`DELETE FROM travel_plans WHERE trip_id = $1 AND NOT (person_id = ANY($2::bigint[]))`, [tripId, legs.map((l) => l.personId)], on);
}

/** Where or when changed: computed plans are stale. People's own "i'll drive" stays. */
export async function resetTravelPlans(tripId: number, on: Queryable = db()): Promise<void> {
  await q(`DELETE FROM travel_plans WHERE trip_id = $1 AND NOT overridden`, [tripId], on);
  await q(`UPDATE travel_plans SET est_cost_cents = NULL, hours = NULL, carpool_group = NULL, link = NULL WHERE trip_id = $1`, [tripId], on);
}

/** Each person's override, from stored plans. */
export async function travelOverrides(tripId: number, on: Queryable = db()): Promise<Map<number, TravelMode>> {
  const rows = await q<{ person_id: number; mode: TravelMode }>(`SELECT person_id, mode FROM travel_plans WHERE trip_id = $1 AND overridden`, [tripId], on);
  return new Map(rows.map((r) => [Number(r.person_id), r.mode]));
}
