-- computer-events
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- What happened to each computer, for its own page: who started it and for
-- which run, who took its screen and gave it back, and who or what stopped it.
-- The audit trail says some of this, but only by the duck's name, never which
-- run a start was for or why a machine stopped by itself, and it has no index
-- a page could read one computer's day from.
--
-- kind: started, stopped (a person, or nobody named), stopped_idle,
-- stopped_long, stopped_left, stopped_off, stopped_paused,
-- stopped_not_allowed, stopped_removed, took, gave_back.
-- user_id: the person who did it; empty when a duck or TameDuck did.
-- job_id: for started, the duck's run it was started for.
CREATE TABLE computer_events(
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  computer_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  user_id TEXT,
  job_id TEXT,
  created TEXT NOT NULL
);
CREATE INDEX computer_events_computer ON computer_events(computer_id, created);
