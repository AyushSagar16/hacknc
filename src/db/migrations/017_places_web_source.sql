-- Places found by a web lookup (search.ts) when there's no map search: no rating or distance,
-- just a name and a one-line detail (kept in category).
ALTER TABLE trip_places DROP CONSTRAINT IF EXISTS trip_places_source_check;
ALTER TABLE trip_places ADD CONSTRAINT trip_places_source_check CHECK (source IN ('serpapi', 'catalog', 'web'));
