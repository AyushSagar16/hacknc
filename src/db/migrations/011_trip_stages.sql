-- Trip stages, off-catalog places, per-person travel plans and the stay slot.
--
-- stages: where each part of the plan stands, {"location": "decided", "dates": "in_progress", ...}
--   for location, dates, travel, stay, food_activities; each open | in_progress | decided. A key
--   that's absent is inferred from the trip row (src/trips/stages.ts), so older trips need no backfill.
-- destination_place: a place locked by name that isn't in data/destinations.json, geocoded with
--   Open-Meteo: {name, admin1, country, countryCode, lat, lon, timezone}. destination_id is null then.
-- stay: the booked stay (workstream D writes it; food & activities read its lat/lon):
--   {name, kind: "hotel"|"rental", address, lat, lon, check_in, check_out, total_cents,
--    per_person_night_cents, rating, link, booked_at}
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS stages            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS destination_place jsonb,
  ADD COLUMN IF NOT EXISTS stay              jsonb;

-- How each person gets to the trip. Travel is a personal cost (their own budget), never the
-- shared trip fund. overridden: the person said "i'll drive" / "i'll fly", so a recompute keeps
-- their mode.
CREATE TABLE IF NOT EXISTS travel_plans (
  trip_id         bigint NOT NULL REFERENCES trips(id),
  person_id       bigint NOT NULL REFERENCES people(id),
  mode            text NOT NULL CHECK (mode IN ('drive', 'fly')),
  origin          text,
  origin_iata     text,
  est_cost_cents  bigint,
  cost_source     text NOT NULL DEFAULT 'estimate' CHECK (cost_source IN ('estimate', 'live')),
  hours           real,
  carpool_group   text,
  overridden      boolean NOT NULL DEFAULT false,
  link            text,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (trip_id, person_id)
);
