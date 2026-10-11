# Atlas memory: research and recommendations

Scope: how Atlas stores, recalls and uses memory, measured against the QA bugs, and what to change.
Constraints: memory stays on Tiger Data (TimescaleDB + pgvector + pgvectorscale, local
`timescale/timescaledb-ha:pg18`, Tiger Cloud in prod), and Gemini's free-tier quota is spent per request.
Researched 2026-10-10.

## 1. Current design (what the code actually does)

**Two memory systems, mostly separate.**

1. **Structured facts** (`facts` table, `src/profile/*`). On every turn with new inbound text,
   `runExtraction` (brain.ts) sends up to 30 unextracted messages from the **last 6 h**, plus the
   **6 previous history lines** as context, to Gemini (`extract.md`, JSON schema). The output is
   validated with zod, `about` is resolved by first-name match, dates are range-checked, and
   `noiseReason` drops budget commands and questions. Everything else is inserted. `aggregate.ts`
   then resolves facts per slot: explicit beats implied, and the newest wins. `describeSituation`
   prints one resolved profile line per member every turn. This is the real source of truth for
   "who wants what". *(Update: facts are now sandboxed per chat. `profilesFor` requires a
   `chatId`, so a person's facts from one group chat never reach another's itinerary.)*
2. **Semantic memory** (`memory_chunks`, `src/memory/*`). A `memory.embed` job after each turn
   embeds speaker-labelled message windows (≤2,400 chars, split on 1 h gaps, ack-only windows
   skipped) and one sentence per new fact (`describeFact`). Decisions are embedded on trip lock.
   It's one `embedContent` call per turn. Recall happens on every agent turn (and in the
   `recall_memory` tool). The query is the batch's new text. It runs one ANN query over a
   `diskann` index (search list 200, rescore 400), with chat/person/visibility applied as
   post-filters. Chunks made only of messages from the last 6 h are excluded. Scoring is
   `sim × (0.85 + 0.15·e^(−age/14d))`, with sim ≥ 0.15 and the top 8 kept. The hits are shown as
   "recalled from earlier chats".
3. **Asks** (`asks` table): `(person, chat, field)` is written only when the agent calls the
   `ask_for_missing_info` tool. The situation tags those fields "already asked".
4. **What the agent sees each turn** (`situation.ts`): trip row, resolved profiles, group date
   window, missing fields, tensions, feature sections (incl. recalled memory), allowed dollar
   figures, hints, the **last 30 chat lines**, and the new messages. Nothing summarises older chat
   or what Atlas itself has already said or promised.
5. **Time-series**: `spend_events` and `weather_snapshots` are hypertables, with two real-time
   continuous aggregates. Columnstore/compression isn't enabled anywhere. `messages` and
   `memory_chunks` are plain tables.

**Live DB snapshot** (local, read-only): 64 messages, 25 turns, 34 chunks (23 message windows,
10 facts, 1 decision), 10 facts. `llm_traces`: 20 agent, 20 extract, 10 gate and 16 memory
recalls. Ten of the 16 recalls returned **0 hits**, all of them early in the chat. Later recalls
returned junk: the query "Yes" got 0.63 on the intro window, and "Ayush fix this bug" got 0.66 on
the same intro. Two stored facts are misreads: `Jason set a budget ceiling — "Can you send the
updated split"` and `Sai is flexible on money — "everyone should be paying the same amount"`.
Both are now embedded and recallable forever.

**Installed / available locally** (`\dx`, `pg_available_extensions`, PG 18.6):

| Extension | Version | State |
|---|---|---|
| timescaledb | 2.30.2 | installed (columnstore API present: `add_columnstore_policy`, `convert_to_columnstore`) |
| timescaledb_toolkit | 1.26.0 | installed |
| vector (pgvector) | 0.8.7 | installed |
| vectorscale (pgvectorscale) | 0.9.1 | installed (diskann; label filtering since 0.7.0, PG18 since 0.9.0) |
| **pg_textsearch** (BM25) | **1.5.1** | **available, already in `shared_preload_libraries`**: only `CREATE EXTENSION` needed |
| pg_trgm, fuzzystrmatch, citext | 1.6 / 1.2 / 1.8 | available |
| ai / pgai | — | **not available**. The pgai project is unmaintained since Feb 2026 and archived May 2026; don't build on it |

## 2. Observed problems mapped to root causes

| # | Bug | Root cause in code |
|---|---|---|
| P1 | "luis: ana is vegetarian" → carmen also vegetarian | `about` comes only from the LLM. The resolver trusts any member first name, and there's no deterministic check that the named person actually appears in the message. Facts also have no `reported_by`, so a third-party report carries the same weight as a self-statement and there's no audit of who said it. |
| P2 | "lol miami?" stored as a veto | Veto rules exist only in the prompt. `noiseReason` has no rule for destination polarity, so a negative destination needs no refusal language. |
| P3 | Home city from message 1 missing later | Extraction only reads `extracted_at IS NULL AND sent_at > now−6h LIMIT 30`. A failed or late extraction, or a long burst, means the messages are never read, with no sweep or alert. Memory windows hold the raw words, but recall skips the last 6 h, and the profile line is the only place the city would surface. |
| P4 | "same dates" not resolved | The extractor sees only 6 prior lines and **no current profiles**, so "same dates as ana" can't resolve when ana's dates were said earlier. Nothing deterministic handles "same as X" either. |
| P5 | Agent asserts state not in the situation ("ravi's dates are set too") | The situation lists what's known but never states the unknowns per person in a form the model must respect. Stale or wrong fact chunks are recalled as "memory" with a ~0.6 similarity floor in practice, and there's no output check of per-person claims against the profile. |
| P6 | Repeated near-identical nudges | Atlas has no memory of its own utterances. `asks` is written only by one tool; free-text questions ("sai, what dates work?") and nudges go unrecorded. No near-duplicate check runs on outbound text. |
| P7 | Recall returns 0 hits early in a chat | `FRESH_MS = 6h` excludes every chunk younger than 6 h, but the agent only sees the last **30 lines**, so a 2-hour, 80-message chat has unseen-but-excluded content. When hits do come, `MIN_SIMILARITY = 0.15` is far below gemini-embedding's baseline cosine (~0.55–0.65 for unrelated short texts), so junk passes. |
| P8 | ~2.5 Gemini calls per turn | Per agent turn: gate (unaddressed only) + extract + agent (+ tool rounds) + query embed + doc embed job. Fact chunks are embedded although the same facts are already in the situation, and the query embed runs even for "yes" or "what happened". |
| P9 | Can't remember past trips | `trips.chat_id` is `UNIQUE`: one trip per chat, ever. The only decision memory is a single "the group locked X" chunk, and itineraries, final costs and who came are never summarised. |

## 3. Tiger Data capabilities (primary sources)

- **pg_textsearch (BM25)**: `CREATE INDEX … USING bm25(col) WITH (text_config='english')`,
  ranked with `ORDER BY col <@> 'query'` (negative scores; lower is better). It needs
  `to_bm25query(q, 'index')` inside PL/pgSQL and for filtering. It supports PG17/18 and is
  production-ready on Tiger Cloud (docs cite v1.1.0; 1.5.x is current). It **doesn't work on
  columnstore-compressed data**, and statistics are per partition, so keep BM25 off hypertables.
  Tiger's own hybrid-search tutorial fuses BM25 + diskann with RRF (k=60) in one SQL statement.
  [repo](https://github.com/timescale/pg_textsearch),
  [docs](https://www.tigerdata.com/docs/use-timescale/latest/extensions/pg-textsearch),
  [hybrid tutorial](https://www.tigerdata.com/docs/learn/tutorials/hybrid-search),
  [launch blog](https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres)
- **pgvectorscale StreamingDiskANN**: SBQ-compressed graph index with
  `diskann.query_search_list_size` / `diskann.query_rescore`. **Filtered DiskANN (0.7.0+)**:
  `CREATE INDEX … USING diskann (embedding vector_cosine_ops, labels)` on a `smallint[]` column,
  queried with `WHERE labels && ARRAY[…]`, so the filter happens *inside* the graph walk.
  Arbitrary WHERE clauses are post-filters (correct but slower, which is what Atlas does now).
  Ordering is relaxed, so re-sort in an outer CTE if strict order matters.
  [repo](https://github.com/timescale/pgvectorscale),
  [releases](https://github.com/timescale/pgvectorscale/releases)
- **Hypercore columnstore**: `ALTER TABLE … SET (timescaledb.enable_columnstore,
  timescaledb.segmentby='chat_id', timescaledb.orderby='at DESC')` + `CALL
  add_columnstore_policy(t, after => INTERVAL '7d')`. This replaces `add_compression_policy`,
  deprecated in 2.18. Bloom filters are on by default.
  [setup](https://www.tigerdata.com/docs/build/columnar-storage/setup-hypercore),
  [add_columnstore_policy](https://www.tigerdata.com/docs/api/latest/hypercore/add_columnstore_policy)
- **Continuous aggregates** (already used): real-time with `materialized_only=false`. A
  continuous aggregate can itself be moved to the columnstore.
- **pgai / vectorizer**: unmaintained since Feb 2026, repo archived 27 May 2026, and Gemini was
  never a named provider. **Don't adopt.** Keep embedding in app code (the current design is
  right). [repo](https://github.com/timescale/pgai)
- **Tiered storage** (Tiger Cloud only): moves old chunks to object storage. It's irrelevant at
  hackathon scale; mention it at most as "message history can tier to S3 on Tiger Cloud".

## 4. Agent-memory patterns and fit

| Pattern | Source | Fit for Atlas |
|---|---|---|
| Tiered memory: core (always in context), recall (searchable history), archival | MemGPT/Letta [arXiv 2310.08560](https://arxiv.org/abs/2310.08560), [Letta docs](https://docs.letta.com/concepts/memgpt) | Atlas already has core (profiles + trip) and recall (chunks). What's missing is a small **core block of Atlas's own state** (what it asked or promised) and **rolling summaries** for the gap between the 30 visible lines and the archive. |
| Fact consolidation with ADD/UPDATE/DELETE/NOOP | Mem0 [arXiv 2504.19413](https://arxiv.org/abs/2504.19413) | `aggregate.ts` already does this deterministically, which is better than an LLM deciding. The gap is that **vector fact chunks never get the UPDATE/DELETE**: superseded or misread facts stay recallable. Stop embedding facts, or mirror supersession into chunks. |
| Retrieval score = relevance + recency + importance | Generative Agents [arXiv 2304.03442](https://arxiv.org/abs/2304.03442) | Keep the recency term. Add importance by kind (decision > summary > window) and use hybrid relevance (BM25 + vector via RRF) instead of raw cosine. |
| Episodic vs semantic | Generative Agents, Letta | Episodic: per-episode summaries and trip archives (hypertable timeline). Semantic: resolved facts. Atlas conflates the two by embedding facts as chunks. |
| Agent self-memory (own utterances, open questions, commitments) | Letta "core memory" blocks; common practice in production assistants | Directly fixes P6 and P5. It's deterministic and costs no Gemini calls. |
| Hybrid lexical + dense retrieval with RRF | Cormack et al. RRF, [SIGIR 2009](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf); Tiger hybrid tutorial | Names, places and dates ("lisbon", "ravi", "dec 15") are exactly where dense embeddings are weak and BM25 is strong. |

## 5. Recommendations (prioritised)

Costs are **Gemini requests per agent turn**. Today that's roughly 2.5 on average: gate on
unaddressed turns, plus extract, agent, query embed and doc embed.

### R1 — DO NOW: Atlas self-memory: an `atlas_log` hypertable for asks, nudges and claims (fixes P6, P5)

- **What:** Classify every outbound message deterministically before send, then append it to a
  time-series log. Each row records the kind (`ask`, `nudge`, `proposal`, `decision_echo`,
  `answer`), the target people, the fields asked about (detected by regex and the planner's
  `missing` list: dates / home_city / budget), and the text. A situation section `# what you
  already said (last 24h)` lists open asks per person with an age ("asked sai for dates 2h ago,
  no answer"). A hard rule blocks posting a nudge if `similarity(text, prior_nudge) > 0.6` via
  **pg_trgm** within the cooldown, with no Gemini call. Make `recordAsk` fire from this
  classifier too, not only from the tool.
- **Tiger feature:** a hypertable plus a real-time continuous aggregate for per-person ask
  cadence; pg_trgm runs in-DB.
- **SQL sketch:**
  ```sql
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE TABLE atlas_log (
    at timestamptz NOT NULL, chat_id bigint NOT NULL, turn_id bigint,
    kind text NOT NULL, targets bigint[] NOT NULL DEFAULT '{}', fields text[] NOT NULL DEFAULT '{}',
    text text NOT NULL, answered_at timestamptz);
  SELECT create_hypertable('atlas_log', by_range('at', INTERVAL '7 days'));
  CREATE INDEX atlas_log_trgm ON atlas_log USING gin (text gin_trgm_ops);
  -- near-duplicate guard
  SELECT 1 FROM atlas_log WHERE chat_id=$1 AND kind IN ('ask','nudge') AND at > $2 - INTERVAL '6 hours'
    AND similarity(text, $3) > 0.6 LIMIT 1;
  CREATE MATERIALIZED VIEW atlas_asks_hourly WITH (timescaledb.continuous, timescaledb.materialized_only=false) AS
    SELECT chat_id, time_bucket('1 hour', at) AS hr, unnest(targets) AS person_id, count(*) AS asks
    FROM atlas_log WHERE kind IN ('ask','nudge') GROUP BY 1,2,3 WITH NO DATA;
  ```
  (If the continuous aggregate rejects `unnest`, store one row per target instead.)
- **Gemini cost:** 0. **Effort:** S–M. **Risk:** low. The classifier may miss a phrasing, which
  only means a missed dedupe.

### R2 — DO NOW: harden fact attribution and polarity, and give the extractor the current profiles (fixes P1, P2, P4)

- **What:**
  1. Add `reported_by bigint` (the sender) to `facts`. If `about ≠ sender`, require the
     about-person's first name (or alias) to appear in the message text, or reject. A third-party
     fact loses to any self-statement in the same slot (`strength()` gets a `self` tier above
     `explicit`).
  2. In `noiseReason`, a negative destination needs refusal language (`no|not|never|hate|pass|skip|veto|too (pricey|expensive|far)|over it|rather not`)
     and is rejected when the message is a short question or laughter (`^(lol|lmao|haha)?\W*\w+\?$`).
     Budget ceilings need a number (this kills the "can you send the updated split" ceiling).
  3. Add a compact `# known so far` block to the extraction prompt (one line per member: dates,
     city), so "same dates" / "same as ana" resolves. Also add a deterministic fallback: if the
     text matches `same (dates|time|as \w+)` and the model returns no date_window, copy the
     referenced person's (or the previous speaker's) resolved window and mark it `explicit=false`.
  4. Raise the extraction context from 6 to 12 lines. Add a sweep job: on any turn, also pick up
     messages with `extracted_at IS NULL` older than 6 h (cap 30), instead of dropping them
     silently (P3).
- **Tiger feature:** plain Postgres. Optionally use a `fuzzystrmatch`/`pg_trgm` name match for
  nicknames.
- **Gemini cost:** 0 extra calls. The prompt grows by about 100 tokens. **Effort:** S.
  **Risk:** low. Over-strict rules could drop a real veto ("miami? no way" still passes).

### R3 — DO NOW: fix recall scope and quality: exclude only what's visible, hybrid BM25 + diskann with RRF, and stop embedding facts (fixes P7, P5, P8)

- **What:**
  1. Replace the 6 h `FRESH_MS` exclusion with the **ids actually printed** in the situation (the
     last 30 history lines plus the new batch). Chunks of older messages from earlier today
     become recallable.
  2. Add a BM25 index on `memory_chunks.content` and fuse it with the vector result via RRF, as
     in Tiger's tutorial. Names, cities and dates now match lexically.
  3. Replace `MIN_SIMILARITY 0.15` with a **relative** cutoff (keep hits within 0.08 of the best,
     and require sim ≥ 0.70 or a BM25 match).
  4. Skip the query embed when the query has fewer than 2 content terms after stop words ("yes",
     "ok do it", "what happened"). Run BM25 alone; it's free.
  5. Stop writing `fact` chunks. Resolved facts are already in the situation every turn, and the chunks go stale and keep misreads alive. Delete existing ones (or exclude
     `kind='fact'`).
  6. Add an `importance` multiplier: decision 1.2, summary 1.1, window 1.0.
- **Tiger feature:** **pg_textsearch BM25 + pgvectorscale diskann + RRF in one SQL statement.**
  This is the strongest Tiger Data showcase available, and pg_textsearch is already preloaded on
  the local image and on Tiger Cloud.
- **SQL sketch:**
  ```sql
  CREATE EXTENSION IF NOT EXISTS pg_textsearch;
  CREATE INDEX memory_chunks_bm25 ON memory_chunks USING bm25(content) WITH (text_config='english');

  WITH scope AS MATERIALIZED (
    SELECT id FROM memory_chunks
    WHERE ((kind IN ('message','decision','summary') AND chat_id=$1))
      AND (visibility='public' OR (NOT $3 AND person_id=$4))
      AND NOT (cardinality(source_ids)>0 AND source_ids <@ $6::bigint[])),
  lex AS (SELECT id, row_number() OVER (ORDER BY content <@> to_bm25query($7,'memory_chunks_bm25')) r
          FROM memory_chunks WHERE id IN (SELECT id FROM scope)
          ORDER BY content <@> to_bm25query($7,'memory_chunks_bm25') LIMIT 30),
  vec AS (SELECT id, row_number() OVER (ORDER BY embedding <=> $5) r, 1-(embedding <=> $5) sim
          FROM memory_chunks WHERE id IN (SELECT id FROM scope)
          ORDER BY embedding <=> $5 LIMIT 30)
  SELECT c.id, c.kind, c.content, c.created_at, v.sim,
         COALESCE(1.0/(60+l.r),0) + COALESCE(1.0/(60+v.r),0) AS rrf
  FROM memory_chunks c LEFT JOIN lex l USING (id) LEFT JOIN vec v USING (id)
  WHERE l.id IS NOT NULL OR v.id IS NOT NULL
  ORDER BY rrf DESC LIMIT 20;   -- then recency × importance rerank in code
  ```
  (`$5` is NULL when the query embed is skipped; the vec CTE then returns nothing.)
- **Gemini cost:** −0.3 to −0.6 per turn (skipped query embeds, plus no fact texts in the doc
  embed). **Effort:** M. **Risk:** medium-low. Check that BM25 scoring through a subquery
  filter stays index-assisted at this scale; it's trivially fast at hundreds of rows either way.

### R4: Rolling episode summaries to bridge the 30-line window (fixes P3, P5; helps P9)

- **What:** When a chat goes quiet for 1 h, or after 40 new messages, a `memory.summarize` job
  asks Gemini for a ≤6-line, speaker-attributed summary of that episode (decisions, open
  questions, who said what). It's stored as `memory_chunks(kind='summary')` and the latest one is
  **always** shown in the situation (`# earlier today`). This is the Letta "recursive summary"
  pattern.
- **Tiger feature:** chunk timeline queried with `time_bucket`. Summary chunks are indexed by
  both BM25 and diskann.
- **Schema:** `ALTER TABLE memory_chunks DROP CONSTRAINT …kind_check, ADD CHECK (kind IN ('message','fact','decision','summary','trip'))`.
- **Gemini cost:** about 1 generate + 1 embed per *episode* (not per turn); with R3 savings,
  overall ≈ neutral. **Effort:** M. **Risk:** a summary can itself hallucinate. Feed it only
  message text plus resolved facts, and tell the agent summaries are lower authority than the
  profile lines.

### R5: Explicit "known / unknown" state block and a claim check on output (fixes P5)

- **What:** Render a per-person table of required fields with `✓ value` / `UNKNOWN`
  ("ravi: dates UNKNOWN (asked 2h ago)"), and add a rule: "never state a person's dates, city or
  budget unless it's ✓ here". After generation, run a deterministic check: for each member name
  in the reply near a field keyword (dates/flying from/budget), verify that field is known.
  Otherwise regenerate once with the error, or strip the sentence.
- **Tiger feature:** none special; it reads `facts` + `atlas_log`.
- **Gemini cost:** about +0.05 per turn (rare regeneration). **Effort:** S–M. **Risk:** false
  positives on casual mentions; scope it to the three high-value fields.

### R6: Pre-filter recall inside the diskann graph with labels (performance; showcases Filtered DiskANN)

- **What:** Add `labels smallint[]` to `memory_chunks` encoding `kind` (1–5), `visibility`
  (10/11) and a **chat bucket** `100 + chat_id % 30000`, and index
  `(embedding vector_cosine_ops, labels)`. The query uses `labels && ARRAY[100 + $1 % 30000]`,
  keeps the exact `chat_id = $1` predicate for collisions, and drops the inflated
  `search_list_size 200 / rescore 400` workaround that exists only because of post-filtering.
- **Tiger feature:** **pgvectorscale Filtered DiskANN (0.7.0+)**.
- **SQL sketch:**
  ```sql
  ALTER TABLE memory_chunks ADD COLUMN labels smallint[] NOT NULL DEFAULT '{}';
  UPDATE memory_chunks SET labels = ARRAY[(100 + chat_id % 30000)::smallint] WHERE chat_id IS NOT NULL;
  DROP INDEX memory_chunks_embedding;
  CREATE INDEX memory_chunks_embedding ON memory_chunks USING diskann (embedding vector_cosine_ops, labels);
  ```
- **Gemini cost:** 0. **Effort:** S. **Risk:** low. There's no quality gain at hackathon scale;
  it's a correctness-at-scale and demo story.

### R7: Trip archive and multiple trips per chat (fixes P9)

- **What:** Drop `UNIQUE (chat_id)` on `trips` (use a partial unique index on active statuses).
  On `done`, write a `kind='trip'` chunk: destination, dates, who came, total spend, from
  `trip_spend_daily`, top itinerary items, and what people liked. No LLM is needed; it's a
  template over tables. New trips can then say "last time you did Gatlinburg in Dec and went
  $X over".
- **Tiger feature:** the continuous aggregate (`trip_spend_daily`) feeds the archive; diskann +
  BM25 recall.
- **SQL:** `ALTER TABLE trips DROP CONSTRAINT trips_chat_id_key; CREATE UNIQUE INDEX trips_one_active ON trips(chat_id) WHERE status <> 'done';`
- **Gemini cost:** 1 embed per finished trip. **Effort:** M, because code assumes one trip per
  chat. **Risk:** medium, from that one-trip assumption.

### R8: Fold the speak gate into extraction (Gemini budget)

- **What:** On unaddressed turns, the extractor already reads the same messages. Add
  `"should_atlas_speak": {speak, reason}` to the extraction JSON schema and drop the separate
  gate call. Keep the deterministic small-talk skip.
- **Gemini cost:** −1 request on every unaddressed non-small-talk turn (≈ −0.4/turn on average).
  **Effort:** S–M. **Risk:** medium. A combined prompt may slightly degrade either task, so A/B
  it on the sim scenarios (`src/sim`).

### R9: Batch embeddings and embed inbound messages once (Gemini budget)

- **What:** `embedContent` already accepts many contents in one request. Send the recall query
  and the previous turn's pending document windows in **one request**. That means deferring the
  `memory.embed` job to piggyback on the next turn's query embed, or on a 60 s debounce for a
  quiet chat.
- **Gemini cost:** −0.5 to −1 request per turn. **Effort:** S. **Risk:** low. Chunks become
  searchable a turn later, which doesn't matter because those lines are still in the visible
  window (R3).

### R10: Make `messages` history a columnstore hypertable (showcase; optional)

- **What:** Keep `messages` relational, since it has an identity PK, a unique provider id and
  FKs from facts and expenses. Add an append-only `message_events` hypertable fed by trigger,
  `segmentby chat_id, orderby at DESC`, with `add_columnstore_policy(after => '7 days')`, and
  serve analytics such as "who's gone quiet", per-person activity and response latency from a
  continuous aggregate. **Don't** put BM25 on it (pg_textsearch doesn't work on compressed
  chunks).
- **Gemini cost:** 0. **Effort:** S. **Risk:** low, though it duplicates storage. It's purely a
  Tiger showcase and dashboard feature; it doesn't improve replies by itself.

## 6. Summary table

| # | Recommendation | Fixes | Tiger feature | Gemini Δ/turn | Effort | Priority |
|---|---|---|---|---|---|---|
| R1 | Atlas self-memory log + trigram dedupe | P6, P5 | hypertable, continuous aggregate, pg_trgm | 0 | S–M | **do now** |
| R2 | Attribution/polarity guards, profiles in extractor, sweep | P1, P2, P3, P4 | Postgres | 0 | S | **do now** |
| R3 | Visible-id exclusion, BM25+diskann RRF, no fact chunks, skip trivial embeds | P7, P5, P8 | pg_textsearch + pgvectorscale | −0.3 to −0.6 | M | **do now** |
| R4 | Rolling episode summaries | P3, P5, P9 | chunks + time_bucket | ≈0 net | M | next |
| R5 | Known/unknown block + claim check | P5 | — | +0.05 | S–M | next |
| R6 | Filtered DiskANN labels | scale | pgvectorscale labels | 0 | S | next (demo) |
| R7 | Trip archive, many trips per chat | P9 | continuous aggregate + chunks | ~0 | M | later |
| R8 | Gate folded into extraction | P8 | — | −0.4 | S–M | next |
| R9 | Batched/deferred embeddings | P8 | — | −0.5 to −1 | S | next |
| R10 | `message_events` columnstore | showcase | hypercore columnstore, continuous aggregate | 0 | S | optional |

R3 + R8 + R9 together should bring the average from about 2.5 to roughly 1.3–1.6 Gemini
requests per turn.

## Sources

- pg_textsearch: https://github.com/timescale/pg_textsearch
- pg_textsearch on Tiger Cloud: https://www.tigerdata.com/docs/use-timescale/latest/extensions/pg-textsearch
- Hybrid search tutorial (BM25 + diskann + RRF): https://www.tigerdata.com/docs/learn/tutorials/hybrid-search
- pg_textsearch launch: https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres
- pgvectorscale (Filtered DiskANN, query params): https://github.com/timescale/pgvectorscale and https://github.com/timescale/pgvectorscale/releases
- Hypercore setup: https://www.tigerdata.com/docs/build/columnar-storage/setup-hypercore
- add_columnstore_policy: https://www.tigerdata.com/docs/api/latest/hypercore/add_columnstore_policy
- pgai (unmaintained/archived): https://github.com/timescale/pgai
- MemGPT: https://arxiv.org/abs/2310.08560 ; Letta: https://docs.letta.com/concepts/memgpt
- Mem0: https://arxiv.org/abs/2504.19413
- Generative Agents: https://arxiv.org/abs/2304.03442
- Reciprocal Rank Fusion: https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
