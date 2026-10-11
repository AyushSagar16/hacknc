-- Food & activities near the stay (docs/plan-trip-stages.md §7). Each row is a place Atlas put on a
-- shortlist (status 'suggested', numbered by idx so people can say "add 2") or one the group picked
-- ('picked', written into the itinerary on day `day`). A new shortlist clears the old suggestions'
-- numbers; picked places stay.
CREATE TABLE IF NOT EXISTS trip_places (
  id           bigserial PRIMARY KEY,
  trip_id      bigint NOT NULL REFERENCES trips(id),
  kind         text NOT NULL CHECK (kind IN ('food', 'activity')),
  idx          int,
  name         text NOT NULL,
  category     text,
  address      text,
  lat          double precision,
  lon          double precision,
  rating       real,
  reviews      int,
  price_level  int CHECK (price_level BETWEEN 1 AND 4),
  distance_m   int,
  source       text NOT NULL DEFAULT 'serpapi' CHECK (source IN ('serpapi', 'catalog')),
  source_id    text NOT NULL,
  status       text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'picked')),
  picked_by    bigint REFERENCES people(id),
  picked_at    timestamptz,
  day          date,
  added_at     timestamptz NOT NULL,
  UNIQUE (trip_id, source_id)
);
CREATE INDEX IF NOT EXISTS trip_places_trip ON trip_places (trip_id, status);
