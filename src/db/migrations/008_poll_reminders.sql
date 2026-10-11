-- When Atlas called out who hasn't voted on a poll (once per poll; see proposals.ts poll.remind).
ALTER TABLE polls ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
