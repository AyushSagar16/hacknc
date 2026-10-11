-- Bank-connect onboarding (docs/plan-trip-stages.md §2). One row per person per chat: Atlas asked
-- them to connect their bank (shown as Capital One, backed by a Nessie customer), sent them a signed
-- link, they connected through the web consent page, or they declined and were asked for a rough
-- budget instead. A Nessie customer is only linked and seeded once someone connects.
CREATE TABLE IF NOT EXISTS bank_connections (
  person_id        bigint NOT NULL REFERENCES people(id),
  chat_id          bigint NOT NULL REFERENCES chats(id),
  status           text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','link_sent','connected','declined')),
  offered_at       timestamptz NOT NULL,
  link_sent_at     timestamptz,
  connected_at     timestamptz,
  announced_at     timestamptz,     -- "<name>'s connected ✓" posted in the group
  declined_at      timestamptz,
  budget_asked_at  timestamptz,     -- after a decline: "what's a rough number?"
  nudged_at        timestamptz,     -- the one follow-up for people who neither connected nor gave a budget
  updated_at       timestamptz NOT NULL,
  PRIMARY KEY (person_id, chat_id)
);
CREATE INDEX IF NOT EXISTS bank_connections_chat ON bank_connections (chat_id);
