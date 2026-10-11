-- Who said a fact (the sender), next to who it is about. A report about a friend ("ana is
-- vegetarian" from luis) is weaker than the friend's own word, and the console can show both.
ALTER TABLE facts ADD COLUMN IF NOT EXISTS reported_by bigint REFERENCES people(id);
