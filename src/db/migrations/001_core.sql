-- Core conversation tables: people, chats, messages, the durable inbound log,
-- the outbox for idempotent sends, the job queue and the job-failure audit table.
-- Timestamps are always supplied by the application clock (src/clock.ts), never now().

CREATE TABLE people (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handle        text NOT NULL UNIQUE,          -- E.164 phone or email; never sent to Nessie
  display_name  text,
  created_at    timestamptz NOT NULL
);

CREATE TABLE chats (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform          text NOT NULL,
  provider_chat_id  text NOT NULL,
  is_group          boolean NOT NULL DEFAULT true,
  quiet_mode        boolean NOT NULL DEFAULT false,
  intro_sent_at     timestamptz,
  timezone          text NOT NULL DEFAULT 'America/New_York',
  created_at        timestamptz NOT NULL,
  UNIQUE (platform, provider_chat_id)
);

CREATE TABLE chat_members (
  chat_id    bigint NOT NULL REFERENCES chats(id),
  person_id  bigint NOT NULL REFERENCES people(id),
  active     boolean NOT NULL DEFAULT true,
  joined_at  timestamptz NOT NULL,
  left_at    timestamptz,
  PRIMARY KEY (chat_id, person_id)
);

-- Every inbound webhook is written here before we acknowledge it.
CREATE TABLE webhook_events (
  webhook_id    text PRIMARY KEY,
  event_type    text NOT NULL,
  received_at   timestamptz NOT NULL,
  payload       jsonb NOT NULL,
  processed_at  timestamptz,
  error         text
);
CREATE INDEX webhook_events_unprocessed ON webhook_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE turns (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id        bigint NOT NULL REFERENCES chats(id),
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','cancelled','failed')),
  addressed      boolean,
  route          text,           -- command | fast_path | agent | gate_silent | ...
  gate_decision  text,
  gate_reason    text,
  cancellable    boolean NOT NULL DEFAULT true,
  latency_ms     integer
);

-- History is scoped per chat. Inbound rows with turn_id IS NULL are the batch queue;
-- a cancelled turn releases its rows (turn_id back to NULL) — that is carry-forward.
CREATE TABLE messages (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id               bigint NOT NULL REFERENCES chats(id),
  person_id             bigint REFERENCES people(id),          -- NULL = Atlas
  provider_message_id   text NOT NULL,
  direction             text NOT NULL CHECK (direction IN ('inbound','outbound')),
  kind                  text NOT NULL DEFAULT 'text',          -- text | reaction | poll_vote | membership
  text                  text NOT NULL,
  reply_to_provider_id  text,
  meta                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at               timestamptz NOT NULL,
  received_at           timestamptz NOT NULL,
  turn_id               bigint REFERENCES turns(id),
  speakable             boolean NOT NULL DEFAULT true,         -- false for stale replays: extraction only
  extracted_at          timestamptz,
  UNIQUE (chat_id, provider_message_id)
);
CREATE INDEX messages_chat_time ON messages (chat_id, sent_at);
CREATE INDEX messages_unclaimed ON messages (chat_id, id) WHERE turn_id IS NULL AND direction = 'inbound';

-- Outbound actions with stable client GUIDs; the send stage resumes from the first non-sent row.
CREATE TABLE outbox (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id              bigint NOT NULL REFERENCES chats(id),
  turn_id              bigint REFERENCES turns(id),
  idx                  integer NOT NULL,
  client_guid          text NOT NULL UNIQUE,
  action               jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  rendered_as          text,          -- native | fallback
  provider_message_id  text,
  attempts             integer NOT NULL DEFAULT 0,
  last_error           text,
  created_at           timestamptz NOT NULL,
  sent_at              timestamptz
);
CREATE INDEX outbox_pending ON outbox (chat_id, id) WHERE status = 'pending';

CREATE TABLE jobs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind           text NOT NULL,
  due_at         timestamptz NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  singleton_key  text,
  attempts       integer NOT NULL DEFAULT 0,
  max_attempts   integer NOT NULL DEFAULT 5,
  locked_at      timestamptz,
  locked_by      text,
  done_at        timestamptz,
  failed_at      timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL
);
CREATE INDEX jobs_due ON jobs (due_at) WHERE done_at IS NULL AND failed_at IS NULL;
CREATE UNIQUE INDEX jobs_singleton ON jobs (singleton_key) WHERE singleton_key IS NOT NULL AND done_at IS NULL AND failed_at IS NULL;

CREATE TABLE job_failures (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue       text NOT NULL,
  job_id      text,
  chat_id     bigint,
  payload     jsonb,
  error       text NOT NULL,
  stack       text,
  created_at  timestamptz NOT NULL
);
CREATE INDEX job_failures_time ON job_failures (created_at);

CREATE TABLE llm_traces (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role           text NOT NULL,       -- gate | agent | extract | embed
  model          text NOT NULL,
  chat_id        bigint,
  turn_id        bigint,
  latency_ms     integer,
  decision       text,
  reason         text,
  error          text,
  created_at     timestamptz NOT NULL
);
CREATE INDEX llm_traces_chat ON llm_traces (chat_id, created_at);
