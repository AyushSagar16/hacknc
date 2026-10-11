-- The trip fund: one shared account per trip (a Nessie customer "<Trip> Trip Fund" with a
-- checking account) that everyone pays their share into on their paydays, and that pays for the
-- stay and anything else the group puts on it. Atlas's ledger mirrors every movement, so the fund
-- works the same with no Nessie key (ledger only) and for people who never connected a bank.

CREATE TABLE IF NOT EXISTS trip_funds (
  trip_id             bigint PRIMARY KEY REFERENCES trips(id),
  nessie_customer_id  text,
  nessie_account_id   text,
  -- every contribution is due by this day (about two weeks before the trip starts)
  deadline            date,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);

-- What the fund pays for: the stay, plus anything the group marks shared ("put the boat on the
-- fund"). shared_by null = everyone in the group. paid_at is set once the fund paid it (a Nessie
-- purchase from the fund account at a merchant named after it).
CREATE TABLE IF NOT EXISTS fund_items (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id             bigint NOT NULL REFERENCES trips(id),
  kind                text NOT NULL CHECK (kind IN ('stay', 'item')),
  description         text NOT NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  shared_by           jsonb,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  paid_at             timestamptz,
  nessie_merchant_id  text,
  nessie_purchase_id  text,
  idempotency_key     text NOT NULL UNIQUE,
  source_message_id   bigint REFERENCES messages(id),
  created_at          timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS fund_items_trip ON fund_items (trip_id) WHERE status = 'active';

-- Money moving in and out of the fund.
--   contribution: a person's checking → fund (a scheduled installment, or a settle-up shortfall)
--   refund:       fund → a person's checking (leftover at settle-up, pro-rata to contributions)
--   purchase:     fund → a merchant (the stay, a shared item); item_id says which
-- via: 'bank' when a Nessie transfer/purchase backs it, 'ledger' when Atlas only tracks it
-- (no key, or the person never connected a bank).
CREATE TABLE IF NOT EXISTS fund_txns (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id             bigint NOT NULL REFERENCES trips(id),
  person_id           bigint REFERENCES people(id),
  kind                text NOT NULL CHECK (kind IN ('contribution', 'refund', 'purchase')),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  due_date            date,
  status              text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done', 'cancelled', 'failed')),
  via                 text CHECK (via IN ('bank', 'ledger')),
  item_id             bigint REFERENCES fund_items(id),
  plan_key            text,
  nessie_transfer_id  text,
  nessie_deposit_id   text,
  idempotency_key     text NOT NULL UNIQUE,
  executed_at         timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS fund_txns_trip ON fund_txns (trip_id, status);

-- A settle-up transfer can go into the trip fund (a shortfall): to_id NULL means the fund.
ALTER TABLE settlements ALTER COLUMN to_id DROP NOT NULL;
