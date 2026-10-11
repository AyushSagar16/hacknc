-- Public trip pages. The Atlas bot is the only writer (service-role key); the Next.js site reads
-- server-side with the same key. RLS is on with no policies, so the anon key can read nothing:
-- a page is reachable only by knowing its UUID.

CREATE TABLE site_chats (
  id          uuid PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_trips (
  id           uuid PRIMARY KEY,
  chat_id      uuid NOT NULL REFERENCES site_chats(id) ON DELETE CASCADE,
  title        text NOT NULL,
  summary      text,
  destination  text,
  start_date   date,
  end_date     date,
  status       text NOT NULL,
  travelers    text[] NOT NULL DEFAULT '{}',
  timezone     text NOT NULL DEFAULT 'America/New_York',
  overview     jsonb NOT NULL DEFAULT '{}',
  itinerary    jsonb NOT NULL DEFAULT '[]',
  version      integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_trips_chat ON site_trips (chat_id, created_at);

CREATE TABLE site_research (
  trip_id     uuid NOT NULL REFERENCES site_trips(id) ON DELETE CASCADE,
  topic       text NOT NULL,
  summary     text NOT NULL,
  body_md     text NOT NULL,
  sources     jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, topic)
);

CREATE TABLE site_messages (
  trip_id     uuid NOT NULL REFERENCES site_trips(id) ON DELETE CASCADE,
  local_id    bigint NOT NULL,
  sender      text NOT NULL,
  from_atlas  boolean NOT NULL DEFAULT false,
  text        text NOT NULL,
  sent_at     timestamptz NOT NULL,
  PRIMARY KEY (trip_id, local_id)
);
CREATE INDEX site_messages_time ON site_messages (trip_id, sent_at);

ALTER TABLE site_chats    ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_trips    ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_research ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_messages ENABLE ROW LEVEL SECURITY;
