-- Memory v2 (docs/memory-research.md R1 + R3).
--
-- atlas_log: everything Atlas says, classified (ask / nudge / proposal / answer / ...), with who it
-- was aimed at and which details it asked for. It's Atlas's memory of its own words: the agent sees
-- its open asks, and pg_trgm similarity blocks a follow-up that restates a recent one.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE atlas_log (
  at          timestamptz NOT NULL,
  chat_id     bigint NOT NULL,
  turn_id     bigint,
  kind        text NOT NULL CHECK (kind IN ('ask', 'nudge', 'proposal', 'decision', 'money', 'answer', 'other')),
  unprompted  boolean NOT NULL DEFAULT false,
  targets     bigint[] NOT NULL DEFAULT '{}',
  fields      text[] NOT NULL DEFAULT '{}',
  text        text NOT NULL
);
SELECT create_hypertable('atlas_log', by_range('at', INTERVAL '7 days'));
CREATE INDEX atlas_log_chat ON atlas_log (chat_id, at DESC);
CREATE INDEX atlas_log_trgm ON atlas_log USING gin (text gin_trgm_ops);

-- Hybrid recall: BM25 (pg_textsearch) next to the diskann vector index, fused with RRF at query
-- time. Names, cities and dates match lexically even when embeddings are vague. Skipped where
-- pg_textsearch isn't available (recall then stays vector-only).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_textsearch')
     AND current_setting('shared_preload_libraries', true) ILIKE '%pg_textsearch%' THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_textsearch';
    EXECUTE 'CREATE INDEX memory_chunks_bm25 ON memory_chunks USING bm25 (content) WITH (text_config = ''english'')';
  END IF;
END $$;
