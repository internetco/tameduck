-- boards-can-be-archived
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- A board is never deleted: its tickets, runs and history have to go on
-- reading correctly. Archiving takes it out of the board list and stops its
-- ducks, and it can be brought back.
ALTER TABLE task_boards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
