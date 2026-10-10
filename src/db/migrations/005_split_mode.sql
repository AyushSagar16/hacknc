-- How the trip's cost is shared: 'by_cost' (each person pays their own travel + share) or
-- 'even' (one equal share each). Set from the chat ("split it evenly").
ALTER TABLE trips ADD COLUMN IF NOT EXISTS split_mode text NOT NULL DEFAULT 'by_cost'
  CHECK (split_mode IN ('by_cost', 'even'));
