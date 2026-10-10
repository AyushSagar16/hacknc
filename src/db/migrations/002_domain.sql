-- Domain tables: extracted facts (memory per person), trips, budgets, Nessie links,
-- proposals, polls, expenses, settlements and caches.

-- One row per observed fact. Resolution (which fact wins) is deterministic code in
-- src/profile/aggregate.ts; superseded_by records the winner for auditability.
CREATE TABLE facts (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id          bigint NOT NULL REFERENCES people(id),
  chat_id            bigint REFERENCES chats(id),
  key                text NOT NULL,      -- e.g. destination, dates_available, dietary, activity, travel_limit
  value              jsonb NOT NULL,
  polarity           text NOT NULL DEFAULT 'positive' CHECK (polarity IN ('positive','negative','neutral')),
  explicit           boolean NOT NULL DEFAULT true,
  confidence         real NOT NULL,
  visibility         text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  source_message_id  bigint REFERENCES messages(id),
  quote              text,
  observed_at        timestamptz NOT NULL,
  retracted          boolean NOT NULL DEFAULT false,
  superseded_by      bigint REFERENCES facts(id)
);
CREATE INDEX facts_person ON facts (person_id, key, observed_at);
CREATE INDEX facts_chat ON facts (chat_id, observed_at);

-- "Ask each person for missing info at most once."
CREATE TABLE asks (
  person_id  bigint NOT NULL REFERENCES people(id),
  chat_id    bigint NOT NULL REFERENCES chats(id),
  field      text NOT NULL,
  asked_at   timestamptz NOT NULL,
  PRIMARY KEY (person_id, chat_id, field)
);

CREATE TABLE trips (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id           bigint NOT NULL UNIQUE REFERENCES chats(id),
  status            text NOT NULL DEFAULT 'planning'
                    CHECK (status IN ('planning','voting','locked','ongoing','settling','done')),
  destination_id    text,
  destination_name  text,
  latitude          double precision,
  longitude         double precision,
  start_date        date,
  end_date          date,
  deposit_deadline  date,
  itinerary         jsonb NOT NULL DEFAULT '[]'::jsonb,
  locked_at         timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL
);

-- Pending confirmations: settle-up transfers, expense disputes, weather swaps.
CREATE TABLE confirmations (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id      bigint NOT NULL REFERENCES chats(id),
  person_id    bigint NOT NULL REFERENCES people(id),
  kind         text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','declined','expired')),
  prompt_message_id text,
  created_at   timestamptz NOT NULL,
  resolved_at  timestamptz
);
CREATE INDEX confirmations_pending ON confirmations (chat_id, person_id) WHERE status = 'pending';

-- Nessie sandbox links. Customers use synthetic persona names only.
CREATE TABLE nessie_links (
  person_id      bigint PRIMARY KEY REFERENCES people(id),
  persona        text NOT NULL,
  customer_id    text,
  checking_id    text,
  savings_id     text,
  credit_id      text,
  seed_status    text NOT NULL DEFAULT 'pending' CHECK (seed_status IN ('pending','seeding','ready','failed')),
  seed_progress  jsonb NOT NULL DEFAULT '{}'::jsonb,
  seeded_at      timestamptz,
  created_at     timestamptz NOT NULL
);

CREATE TABLE nessie_merchants (
  name         text PRIMARY KEY,
  category     text NOT NULL,
  merchant_id  text NOT NULL,
  created_at   timestamptz NOT NULL
);

-- Last-good responses so a Nessie outage cannot break a demo.
CREATE TABLE nessie_cache (
  cache_key   text PRIMARY KEY,
  body        jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL
);

-- Audit of every Nessie call (URL redacted), shown in the judge console.
CREATE TABLE nessie_calls (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  method      text NOT NULL,
  path        text NOT NULL,
  status      integer,
  ok          boolean NOT NULL,
  from_cache  boolean NOT NULL DEFAULT false,
  object_id   text,
  error       text,
  latency_ms  integer,
  person_id   bigint,
  created_at  timestamptz NOT NULL
);
CREATE INDEX nessie_calls_time ON nessie_calls (created_at);

CREATE TABLE budgets (
  person_id        bigint NOT NULL REFERENCES people(id),
  trip_id          bigint NOT NULL REFERENCES trips(id),
  suggested_cents  bigint,
  adjusted_cents   bigint,
  inputs           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- formula inputs + Nessie object ids
  visibility       text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  announced_at     timestamptz,
  updated_at       timestamptz NOT NULL,
  PRIMARY KEY (person_id, trip_id)
);

CREATE TABLE proposals (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id     bigint NOT NULL REFERENCES trips(id),
  options     jsonb NOT NULL,       -- three options with cost breakdowns and price sources
  inputs      jsonb NOT NULL,       -- the group view used to build them
  created_at  timestamptz NOT NULL
);

CREATE TABLE polls (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id           bigint NOT NULL REFERENCES trips(id),
  chat_id           bigint NOT NULL REFERENCES chats(id),
  kind              text NOT NULL DEFAULT 'destination',   -- destination | weather_swap
  title             text NOT NULL,
  options           jsonb NOT NULL,                          -- [{title, ref}]
  provider_poll_id  text,
  option_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,    -- text fallback: one message per option
  rendered_as       text NOT NULL DEFAULT 'text',             -- native | text
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  winner_idx        integer,
  proposal_id       bigint REFERENCES proposals(id),
  created_at        timestamptz NOT NULL,
  closed_at         timestamptz
);
CREATE UNIQUE INDEX polls_one_open ON polls (chat_id, kind) WHERE status = 'open';

CREATE TABLE votes (
  poll_id     bigint NOT NULL REFERENCES polls(id),
  person_id   bigint NOT NULL REFERENCES people(id),
  option_idx  integer NOT NULL,
  selected    boolean NOT NULL DEFAULT true,
  source      text NOT NULL CHECK (source IN ('native','tapback','text','agent')),
  voted_at    timestamptz NOT NULL,
  PRIMARY KEY (poll_id, person_id, option_idx)
);

CREATE TABLE installments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id          bigint NOT NULL REFERENCES trips(id),
  person_id        bigint NOT NULL REFERENCES people(id),
  due_date         date NOT NULL,
  amount_cents     bigint NOT NULL,
  nessie_bill_id   text,
  status           text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','paid','cancelled','failed')),
  idempotency_key  text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL
);

CREATE TABLE expenses (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id             bigint NOT NULL REFERENCES trips(id),
  payer_id            bigint NOT NULL REFERENCES people(id),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  description         text NOT NULL,
  category            text NOT NULL DEFAULT 'other',
  shares              jsonb NOT NULL,                -- {person_id: cents}
  items               jsonb NOT NULL DEFAULT '[]'::jsonb,
  nessie_purchase_id  text,
  nessie_merchant_id  text,
  source_message_id   bigint REFERENCES messages(id),
  idempotency_key     text NOT NULL UNIQUE,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  replaces_id         bigint REFERENCES expenses(id),
  spent_on            date NOT NULL,
  created_at          timestamptz NOT NULL
);
CREATE INDEX expenses_trip ON expenses (trip_id) WHERE status = 'active';

CREATE TABLE settlements (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id            bigint NOT NULL REFERENCES trips(id),
  from_id            bigint NOT NULL REFERENCES people(id),
  to_id              bigint NOT NULL REFERENCES people(id),
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  status             text NOT NULL DEFAULT 'proposed'
                     CHECK (status IN ('proposed','confirmed','executing','executed','failed','cancelled')),
  plan_id            text NOT NULL,
  nessie_transfer_id text,
  nessie_deposit_id  text,
  idempotency_key    text NOT NULL UNIQUE,
  last_error         text,
  confirmed_at       timestamptz,
  executed_at        timestamptz,
  created_at         timestamptz NOT NULL
);

CREATE TABLE price_cache (
  cache_key   text PRIMARY KEY,
  provider    text NOT NULL,
  body        jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL
);

CREATE TABLE weather_alerts (
  trip_id  bigint NOT NULL REFERENCES trips(id),
  day      date NOT NULL,
  kind     text NOT NULL,
  message  text NOT NULL,
  sent_at  timestamptz NOT NULL
);
CREATE INDEX weather_alerts_trip ON weather_alerts (trip_id, day, sent_at);

-- Operator overrides for rehearsal: injected forecasts take precedence over Open-Meteo.
CREATE TABLE weather_overrides (
  trip_id     bigint NOT NULL REFERENCES trips(id),
  day         date NOT NULL,
  forecast    jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (trip_id, day)
);
