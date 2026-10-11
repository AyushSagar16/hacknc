-- One id per Atlas database. Bank-connect links carry it, and the trip site files each approval
-- under it in Supabase (connect_events), so an Atlas only picks up approvals for its own people
-- when several share one Supabase project.
CREATE TABLE IF NOT EXISTS app_meta (
  key    text PRIMARY KEY,
  value  text NOT NULL
);
INSERT INTO app_meta (key, value) VALUES ('instance_id', gen_random_uuid()::text) ON CONFLICT (key) DO NOTHING;
