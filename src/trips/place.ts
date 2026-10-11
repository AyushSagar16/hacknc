// A geocoded place that isn't in the catalog, shaped as a catalog Destination so the rest of the
// trip engine (drive hours, travel plans, estimates, booking links, live pricing) works on it
// unchanged. Numbers are labeled estimates: flight bands from straight-line distance to each
// origin region, and middle-of-the-road daily costs. Live SerpApi prices replace them when a key
// is set (the nearest home airport within reach stands in as the arrival airport).
import { airports, destinationById, ORIGIN_REGIONS, type Airport, type Destination, type FlightBand, type OriginRegion, type Region } from "./catalog.ts";
import { DRIVE_OVERHEAD_HOURS, haversineMiles, ROAD_FACTOR, ROAD_MPH } from "./estimate.ts";
import type { TripPlace, TripRow } from "./state.ts";

/** An airport this close (straight line) counts as the place's own airport. */
export const NEAREST_AIRPORT_MILES = 110;

/** Generic per-person costs for a place we know nothing about but its location. */
const GENERIC_COSTS: Destination["costs"] = {
  lodgingPerNightCents: { budget: 5_500, mid: 9_500 },
  foodPerDayCents: { budget: 4_500, mid: 7_500 },
  activitiesPerDayCents: { budget: 2_500, mid: 5_000 },
  localTransportPerDayCents: 1_500,
};

export function slugOf(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "place"
  );
}

/** The closest home airport to a point, with its distance; undefined when none is within `maxMiles`. */
export function nearestAirport(lat: number, lon: number, maxMiles = NEAREST_AIRPORT_MILES): { airport: Airport; miles: number } | undefined {
  let best: { airport: Airport; miles: number } | undefined;
  for (const a of airports()) {
    const miles = haversineMiles(lat, lon, a.lat, a.lon);
    if (!best || miles < best.miles) best = { airport: a, miles };
  }
  return best && best.miles <= maxMiles ? best : undefined;
}

let centroids: Map<OriginRegion, { lat: number; lon: number }> | undefined;
/** The middle of each origin region, from the home airports in it. */
function regionCentroids(): Map<OriginRegion, { lat: number; lon: number }> {
  if (centroids) return centroids;
  centroids = new Map();
  for (const r of ORIGIN_REGIONS) {
    const inRegion = airports().filter((a) => a.region === r);
    if (!inRegion.length) continue;
    centroids.set(r, { lat: inRegion.reduce((s, a) => s + a.lat, 0) / inRegion.length, lon: inRegion.reduce((s, a) => s + a.lon, 0) / inRegion.length });
  }
  return centroids;
}

/** A typical round-trip fare band and door-to-door hours for a flight of this many miles. */
export function flightBandForMiles(miles: number, hasAirport: boolean): FlightBand {
  const low = Math.round((9_000 + miles * 9) / 500) * 500;
  const high = Math.round((low * 1.7) / 500) * 500;
  // Gate-to-gate at ~480 mph plus airport time; no airport nearby means a connection and a drive.
  const hours = Math.round((miles / 480 + 1.5 + (hasAirport ? 0 : 1.5)) * 2) / 2;
  return { roundTripCents: [low, high], hours };
}

function regionOf(p: TripPlace, nearest: Airport | undefined): Region {
  const cc = (p.countryCode ?? "").toUpperCase();
  const us = cc === "US" || p.country === "United States";
  if (us && /hawaii/i.test(p.admin1 ?? "")) return "hawaii";
  if (us) return nearest?.region ?? "southeast_us";
  if (cc === "CA" || p.country === "Canada") return "canada";
  if (cc === "MX" || p.country === "Mexico") return "mexico";
  if (["PR", "DO", "BS", "JM", "CU", "BB", "AW", "TC", "KY", "VI", "LC"].includes(cc)) return "caribbean";
  if (["CR", "PA", "GT", "BZ", "HN", "NI", "SV"].includes(cc)) return "central_america";
  if (["CO", "PE", "BR", "AR", "CL", "EC", "BO", "UY", "PY", "VE"].includes(cc)) return "south_america";
  return "europe";
}

/** The place as a catalog-shaped Destination (id "place:<slug>"). */
export function placeAsDestination(p: TripPlace): Destination {
  const near = nearestAirport(p.lat, p.lon);
  const country = p.country ?? (p.countryCode === "US" ? "United States" : "Unknown");
  const region = regionOf(p, near?.airport);
  const drivable = (country === "United States" || country === "Canada") && region !== "hawaii";
  const flightFromRegion: Partial<Record<OriginRegion, FlightBand>> = {};
  const driveFromRegion: Partial<Record<OriginRegion, number>> = {};
  for (const [r, c] of regionCentroids()) {
    const miles = haversineMiles(c.lat, c.lon, p.lat, p.lon);
    const driveHours = Math.round(((miles * ROAD_FACTOR) / ROAD_MPH + DRIVE_OVERHEAD_HOURS) * 2) / 2;
    if (drivable && driveHours <= 10) driveFromRegion[r] = Math.max(0.5, driveHours);
    // A place inside the region you're flying from is a drive, not a flight.
    if (miles < 150) continue;
    flightFromRegion[r] = flightBandForMiles(miles, Boolean(near));
  }
  const neutral = 0.6;
  return {
    id: `place:${slugOf(p.name)}`,
    name: p.name,
    ...(p.admin1 ? { state: p.admin1 } : {}),
    country,
    region,
    iata: near?.airport.iata ?? "",
    lat: p.lat,
    lon: p.lon,
    timezone: p.timezone ?? "UTC",
    passportRequired: country !== "United States",
    aliases: [],
    tags: [],
    dietary: { vegetarian: neutral, vegan: neutral, halal: neutral, kosher: neutral, gluten_free: neutral },
    bestMonths: [],
    badMonths: [],
    costs: GENERIC_COSTS,
    flightFromRegion,
    driveFromRegion,
    activities: [],
  };
}

/** The trip's destination: the catalog entry, else its geocoded place; undefined when nothing is locked. */
export function tripDestination(trip: Pick<TripRow, "destination_id" | "destination_place">): Destination | undefined {
  if (trip.destination_id) {
    const d = destinationById(trip.destination_id);
    if (d) return d;
  }
  return trip.destination_place ? placeAsDestination(trip.destination_place) : undefined;
}

/** The place behind a Destination made by placeAsDestination; undefined for catalog entries. */
export function placeOf(dest: Destination): TripPlace | undefined {
  if (!dest.id.startsWith("place:")) return undefined;
  return {
    name: dest.name,
    ...(dest.state ? { admin1: dest.state } : {}),
    ...(dest.country !== "Unknown" ? { country: dest.country } : {}),
    ...(dest.country === "United States" ? { countryCode: "US" } : {}),
    lat: dest.lat,
    lon: dest.lon,
    timezone: dest.timezone,
  };
}
