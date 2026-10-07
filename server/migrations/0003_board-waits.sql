-- The task-board email: its memory, and the switch that turns it off.
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- board_waits is what server/board-reminders.mjs remembers: each task waiting
-- on a person, when that wait was first seen, and whether everybody has been
-- told. A row goes when its wait is over, so the table only ever holds what is
-- waiting now.
CREATE TABLE board_waits(
  key TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  told INTEGER NOT NULL DEFAULT 0);

-- And the switch to turn it off. On for everybody, including people who have
-- already saved their email settings: they keep what they chose for the rest.
ALTER TABLE email_settings ADD COLUMN boards INTEGER NOT NULL DEFAULT 1;
