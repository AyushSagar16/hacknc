-- Several trips per chat, public trip pages, and research notes.
-- A chat works on one focused trip at a time (chats.focus_trip_id); every trip has an
-- unguessable public_id that is its page URL. Messages and trip-scoped facts (where, when,
-- how long, budget talk) are stamped with the trip they were about; facts about the person
-- (diet, home city, interests...) stay unscoped and follow them across trips.

ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_chat_id_key;
CREATE INDEX IF NOT EXISTS trips_chat ON trips (chat_id, created_at);
ALTER TABLE trips
  ADD COLUMN public_id            uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN title                text,
  -- A few sentences Atlas writes about where the plan stands (set_trip_summary).
  ADD COLUMN summary              text,
  ADD COLUMN site_version         integer NOT NULL DEFAULT 0,
  ADD COLUMN site_message_cursor  bigint NOT NULL DEFAULT 0,
  -- [{label, url}] booking links posted at lock-in, kept for the trip page.
  ADD COLUMN booking              jsonb NOT NULL DEFAULT '[]';

ALTER TABLE chats
  ADD COLUMN focus_trip_id  bigint REFERENCES trips(id),
  ADD COLUMN public_id      uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;

UPDATE chats c SET focus_trip_id = t.id FROM trips t WHERE t.chat_id = c.id;

ALTER TABLE messages ADD COLUMN trip_id bigint REFERENCES trips(id);
UPDATE messages m SET trip_id = c.focus_trip_id FROM chats c WHERE c.id = m.chat_id AND c.focus_trip_id IS NOT NULL;
CREATE INDEX messages_trip ON messages (trip_id, id);

ALTER TABLE facts ADD COLUMN trip_id bigint REFERENCES trips(id);
UPDATE facts f SET trip_id = c.focus_trip_id
  FROM chats c
  WHERE c.id = f.chat_id AND c.focus_trip_id IS NOT NULL
    AND f.key IN ('destination', 'date_window', 'trip_length', 'budget_comment');

DROP INDEX IF EXISTS polls_one_open;
CREATE UNIQUE INDEX polls_one_open ON polls (trip_id, kind) WHERE status = 'open';

CREATE TABLE trip_research (
  id          bigserial PRIMARY KEY,
  trip_id     bigint NOT NULL REFERENCES trips(id),
  topic       text NOT NULL,
  summary     text NOT NULL,
  body_md     text NOT NULL,
  sources     jsonb NOT NULL DEFAULT '[]',
  model       text,
  created_at  timestamptz NOT NULL,
  UNIQUE (trip_id, topic)
);
