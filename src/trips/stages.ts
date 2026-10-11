// Where each part of a trip's plan stands. Five stages in the order Atlas settles them:
// location → dates → travel → stay → food & activities, each open | in_progress | decided.
// Atlas nudges toward the earliest stage that isn't decided, but info that arrives out of order
// is still recorded (dates can be decided before the place). Reopening a stage resets the stages
// that depend on it: location resets everything after it; dates reset travel, stay and food.
// Stored in trips.stages; a stage with no stored value is inferred from the trip row, so trips
// from before stages existed read correctly.
import { db, one, type Queryable } from "../db/pool.ts";
import { now } from "../clock.ts";
import type { TripRow } from "./state.ts";

export const STAGES = ["location", "dates", "travel", "stay", "food_activities"] as const;
export type Stage = (typeof STAGES)[number];
export type StageStatus = "open" | "in_progress" | "decided";
export type StageMap = Record<Stage, StageStatus>;

export const STAGE_LABEL: Record<Stage, string> = {
  location: "location",
  dates: "dates",
  travel: "travel",
  stay: "stay",
  food_activities: "food & activities",
};

/** Stages that go back to open when this one is reopened. */
export const DEPENDENTS: Record<Stage, readonly Stage[]> = {
  location: ["dates", "travel", "stay", "food_activities"],
  dates: ["travel", "stay", "food_activities"],
  travel: [],
  stay: [],
  food_activities: [],
};

export function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

const LOCKED = new Set(["locked", "ongoing", "settling", "done"]);

/** What the trip row alone says about each stage (used for stages with nothing stored). */
export function inferStages(trip: Pick<TripRow, "status" | "destination_name" | "start_date" | "end_date" | "stay">): StageMap {
  const located = Boolean(trip.destination_name) && LOCKED.has(trip.status);
  return {
    location: located ? "decided" : trip.status === "voting" ? "in_progress" : "open",
    dates: trip.start_date && trip.end_date && located ? "decided" : "open",
    travel: "open",
    stay: trip.stay ? "decided" : "open",
    food_activities: "open",
  };
}

/** Stored stages over inferred ones. */
export function stagesOf(trip: Pick<TripRow, "status" | "destination_name" | "start_date" | "end_date" | "stay" | "stages">): StageMap {
  const inferred = inferStages(trip);
  const stored = trip.stages ?? {};
  const out = { ...inferred };
  for (const s of STAGES) {
    const v = stored[s];
    if (v === "open" || v === "in_progress" || v === "decided") out[s] = v;
  }
  return out;
}

/** The earliest stage that isn't decided yet; null when everything is. */
export function nextStage(map: StageMap): Stage | null {
  return STAGES.find((s) => map[s] !== "decided") ?? null;
}

/** Reopen a stage: it goes back to in_progress and every dependent stage to open. Pure. */
export function cascadeReopen(map: StageMap, stage: Stage): { map: StageMap; reset: Stage[] } {
  const next = { ...map, [stage]: "in_progress" as StageStatus };
  const reset: Stage[] = [];
  for (const d of DEPENDENTS[stage]) {
    if (next[d] !== "open") reset.push(d);
    next[d] = "open";
  }
  return { map: next, reset };
}

/** "location ✓ · dates (in progress) · travel · stay · food & activities". */
export function describeStages(map: StageMap): string {
  return STAGES.map((s) => `${STAGE_LABEL[s]}${map[s] === "decided" ? " ✓" : map[s] === "in_progress" ? " (in progress)" : ""}`).join(" · ");
}

/** Store only the stages that were set explicitly; the rest keep following the trip row. */
async function write(tripId: number, patch: Partial<StageMap>, on: Queryable): Promise<void> {
  await one(`UPDATE trips SET stages = stages || $2::jsonb, updated_at = $3 WHERE id = $1 RETURNING id`, [tripId, JSON.stringify(patch), now()], on);
}

async function load(tripId: number, on: Queryable): Promise<TripRow> {
  const row = await one<TripRow>(`SELECT * FROM trips WHERE id = $1`, [tripId], on);
  if (!row) throw new Error(`no trip ${tripId}`);
  return row;
}

export async function getStages(tripId: number, on: Queryable = db()): Promise<StageMap> {
  return stagesOf(await load(tripId, on));
}

/**
 * Set one stage. Never downgrades a decided stage to in_progress (a new poll about something
 * already decided goes through reopenStage); `force` allows it.
 */
export async function setStage(tripId: number, stage: Stage, status: StageStatus, opts: { force?: boolean; on?: Queryable } = {}): Promise<StageMap> {
  const on = opts.on ?? db();
  const trip = await load(tripId, on);
  const map = stagesOf(trip);
  if (map[stage] === status && trip.stages?.[stage] === status) return map;
  if (map[stage] === "decided" && status === "in_progress" && !opts.force) return map;
  await write(tripId, { [stage]: status }, on);
  return { ...map, [stage]: status };
}

/** Reopen a stage and reset what depends on it. Returns the new map and the stages that were reset. */
export async function reopenStage(tripId: number, stage: Stage, on: Queryable = db()): Promise<{ stages: StageMap; reset: Stage[] }> {
  const map = stagesOf(await load(tripId, on));
  const { map: next, reset } = cascadeReopen(map, stage);
  await write(tripId, Object.fromEntries([stage, ...DEPENDENTS[stage]].map((s) => [s, next[s]])), on);
  return { stages: next, reset };
}
