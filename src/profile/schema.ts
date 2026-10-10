// What Atlas extracts from chat about each person. The model proposes facts in this shape;
// zod validates them; src/profile/aggregate.ts decides deterministically which ones win.
import { z } from "zod";

export const FACT_KEYS = [
  "destination", // a place they want (positive) or veto (negative)
  "date_window", // earliest/latest they can travel
  "blackout", // dates they can't travel
  "trip_length", // min/max nights
  "dietary", // a dietary need
  "activity", // an interest tag they like (positive) or dislike (negative)
  "travel_limit", // no flying, max flight/drive hours, no passport, low mobility
  "budget_comment", // "too pricey for me", "i can do 600", "money's tight"
  "home_city", // where they'd leave from
  "name", // what they're called
] as const;
export type FactKey = (typeof FACT_KEYS)[number];

export const DIETARY = ["vegetarian", "vegan", "halal", "kosher", "gluten_free", "dairy_free", "nut_allergy", "pescatarian"] as const;
export const ACTIVITY_TAGS = [
  "beach", "food", "nightlife", "culture", "outdoors", "hiking", "mountains", "city", "music",
  "relaxing", "adventure", "shopping", "history", "snow", "walkable", "budget_friendly", "luxury",
] as const;
export const TRAVEL_LIMITS = ["no_flying", "max_flight_hours", "max_drive_hours", "no_passport", "low_mobility"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const factValueSchemas = {
  destination: z.object({ name: z.string().min(2).max(60) }),
  date_window: z.object({ earliest: isoDate.nullish(), latest: isoDate.nullish() }),
  blackout: z.object({ start: isoDate, end: isoDate }),
  trip_length: z.object({ minNights: z.number().int().min(1).max(30).nullish(), maxNights: z.number().int().min(1).max(30).nullish() }),
  dietary: z.object({ need: z.enum(DIETARY) }),
  activity: z.object({ tag: z.enum(ACTIVITY_TAGS) }),
  travel_limit: z.object({ kind: z.enum(TRAVEL_LIMITS), hours: z.number().min(0).max(48).nullish() }),
  budget_comment: z.object({
    kind: z.enum(["ceiling", "too_expensive", "tight", "flexible"]),
    amountUsd: z.number().min(0).max(100_000).nullish(),
    about: z.string().max(60).nullish(),
  }),
  home_city: z.object({ city: z.string().min(2).max(60) }),
  name: z.object({ name: z.string().min(1).max(30) }),
} satisfies Record<FactKey, z.ZodType>;

export type FactValue<K extends FactKey> = z.infer<(typeof factValueSchemas)[K]>;

export interface Fact {
  id: number;
  personId: number;
  key: FactKey;
  value: Record<string, unknown>;
  polarity: "positive" | "negative" | "neutral";
  explicit: boolean;
  confidence: number;
  visibility: "public" | "private";
  sourceMessageId: number | null;
  quote: string | null;
  observedAt: Date;
  retracted: boolean;
}

/** JSON Schema handed to Gemini for structured extraction (validated again with zod after).
 *  Value fields are flat and optional so the model never has to invent a nested shape. */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          message: { type: "integer", description: "index of the message the fact comes from" },
          about: { type: "string", description: "first name of the person the fact is about (usually the sender)" },
          key: { type: "string", enum: [...FACT_KEYS] },
          polarity: { type: "string", enum: ["positive", "negative", "neutral"] },
          explicit: { type: "boolean", description: "true if stated directly, false if implied" },
          retracts: { type: "boolean", description: "true if this takes back something they said earlier" },
          confidence: { type: "number", description: "0 to 1" },
          quote: { type: "string", description: "the exact words, under 12 words" },
          place: { type: "string", description: "destination: the place name" },
          earliest: { type: "string", description: "date_window: YYYY-MM-DD" },
          latest: { type: "string", description: "date_window: YYYY-MM-DD" },
          start: { type: "string", description: "blackout: YYYY-MM-DD" },
          end: { type: "string", description: "blackout: YYYY-MM-DD" },
          min_nights: { type: "integer" },
          max_nights: { type: "integer" },
          need: { type: "string", enum: [...DIETARY] },
          tag: { type: "string", enum: [...ACTIVITY_TAGS] },
          limit: { type: "string", enum: [...TRAVEL_LIMITS] },
          hours: { type: "number" },
          budget_kind: { type: "string", enum: ["ceiling", "too_expensive", "tight", "flexible"] },
          amount_usd: { type: "number" },
          budget_about: { type: "string", description: "budget_comment: what it's about, e.g. a place" },
          city: { type: "string", description: "home_city" },
          name: { type: "string", description: "name: what they're called" },
        },
        required: ["message", "about", "key", "polarity", "explicit", "retracts", "confidence", "quote"],
      },
    },
    tensions: {
      type: "array",
      description: "places where people want opposite things right now",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          sides: { type: "array", items: { type: "string" } },
        },
        required: ["topic", "sides"],
      },
    },
  },
  required: ["facts", "tensions"],
};

/** Build the typed value for a key from the model's flat fields; undefined if it doesn't validate. */
export function toFactValue(key: FactKey, raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const pick: Record<FactKey, () => unknown> = {
    destination: () => ({ name: raw.place }),
    date_window: () => ({ earliest: raw.earliest ?? null, latest: raw.latest ?? null }),
    blackout: () => ({ start: raw.start, end: raw.end ?? raw.start }),
    trip_length: () => ({ minNights: raw.min_nights ?? null, maxNights: raw.max_nights ?? null }),
    dietary: () => ({ need: raw.need }),
    activity: () => ({ tag: raw.tag }),
    travel_limit: () => ({ kind: raw.limit, hours: raw.hours ?? null }),
    budget_comment: () => ({ kind: raw.budget_kind, amountUsd: raw.amount_usd ?? null, about: raw.budget_about ?? null }),
    home_city: () => ({ city: raw.city }),
    name: () => ({ name: raw.name }),
  };
  const parsed = factValueSchemas[key].safeParse(pick[key]());
  return parsed.success ? (parsed.data as Record<string, unknown>) : undefined;
}
