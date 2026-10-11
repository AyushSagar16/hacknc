-- Money a person moved between their own checking and savings by texting Atlas privately
-- ("move 200 to savings"). One row per message, so a redelivered text never moves money twice.
-- The Nessie ids are set once the transfer is made there; without Nessie (offline profiles) the
-- row itself is the record, replayed on top of the generated history.
CREATE TABLE IF NOT EXISTS bank_transfers (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id          bigint NOT NULL REFERENCES people(id),
  source_message_id  bigint UNIQUE,
  from_account       text NOT NULL CHECK (from_account IN ('checking', 'savings')),
  to_account         text NOT NULL CHECK (to_account IN ('checking', 'savings')),
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  transfer_date      date NOT NULL,
  nessie_transfer_id text,
  nessie_deposit_id  text,
  created_at         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS bank_transfers_person ON bank_transfers (person_id, created_at);
