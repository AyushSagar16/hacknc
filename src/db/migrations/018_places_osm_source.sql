-- Places from OpenStreetMap (Photon) near the stay, for specific asks when there's no map search.
ALTER TABLE trip_places DROP CONSTRAINT IF EXISTS trip_places_source_check;
ALTER TABLE trip_places ADD CONSTRAINT trip_places_source_check CHECK (source IN ('serpapi', 'catalog', 'web', 'osm'));
