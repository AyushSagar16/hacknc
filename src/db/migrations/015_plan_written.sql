-- When Atlas (or the catalog fallback) wrote the trip's day-by-day plan. The plan now comes after
-- the stay and the food & activities picks, and picks alone put items on the itinerary, so "has
-- items" no longer means "the plan is written".
ALTER TABLE trips ADD COLUMN IF NOT EXISTS plan_written_at timestamptz;
UPDATE trips SET plan_written_at = updated_at
 WHERE plan_written_at IS NULL
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(itinerary) d WHERE jsonb_array_length(d->'items') > 0);
