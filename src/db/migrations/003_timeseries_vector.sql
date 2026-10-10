-- Tiger Data features: pgvector (+ pgvectorscale when available) for long-term memory,
-- and hypertables for spend events and forecast snapshots.

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvectorscale unavailable (%); memory falls back to HNSW', SQLERRM;
END $$;

-- Long-term semantic memory. History rows carry chat_id; person facts carry person_id
-- and are retrieved across chats (memory per person, history per chat).
CREATE TABLE memory_chunks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id     bigint REFERENCES chats(id),
  person_id   bigint REFERENCES people(id),
  kind        text NOT NULL CHECK (kind IN ('message','fact','decision')),
  content     text NOT NULL,
  embedding   vector(768),
  visibility  text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  source_ids  bigint[] NOT NULL DEFAULT '{}',
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL
);
CREATE INDEX memory_chunks_chat ON memory_chunks (chat_id, created_at);
CREATE INDEX memory_chunks_person ON memory_chunks (person_id, created_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vectorscale') THEN
    EXECUTE 'CREATE INDEX memory_chunks_embedding ON memory_chunks USING diskann (embedding vector_cosine_ops)';
  ELSE
    EXECUTE 'CREATE INDEX memory_chunks_embedding ON memory_chunks USING hnsw (embedding vector_cosine_ops)';
  END IF;
END $$;

-- Append-only spend ledger (+ on log, − on void), the source for trip_spend_daily.
CREATE TABLE spend_events (
  at            timestamptz NOT NULL,
  trip_id       bigint NOT NULL,
  expense_id    bigint NOT NULL,
  category      text NOT NULL,
  amount_cents  bigint NOT NULL
);
SELECT create_hypertable('spend_events', by_range('at', INTERVAL '7 days'));

-- Every forecast fetch for a trip day, the source for forecast_drift_daily.
CREATE TABLE weather_snapshots (
  fetched_at           timestamptz NOT NULL,
  trip_id              bigint NOT NULL,
  day                  date NOT NULL,
  weather_code         integer NOT NULL,
  category             text NOT NULL,
  precip_probability   integer,
  temp_max_f           real,
  temp_min_f           real,
  wind_gust_mph        real,
  source               text NOT NULL DEFAULT 'open-meteo',
  PRIMARY KEY (trip_id, day, fetched_at)
);
SELECT create_hypertable('weather_snapshots', by_range('fetched_at', INTERVAL '7 days'));
