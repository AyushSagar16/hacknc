-- Bank-connect approvals. The consent page inserts one row per Connect press; the Atlas whose
-- instance id is in the link picks it up (polling with the service-role key), runs the same
-- signed-callback check as POST /connect-callback, and stamps processed_at. No inbound connection
-- to Atlas is needed, so it works behind the linq relay with no tunnel. RLS on, no policies.

CREATE TABLE connect_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instance      text NOT NULL,
  token         text NOT NULL,
  signature     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  result        jsonb
);
CREATE INDEX connect_events_pending ON connect_events (instance, id) WHERE processed_at IS NULL;

ALTER TABLE connect_events ENABLE ROW LEVEL SECURITY;
