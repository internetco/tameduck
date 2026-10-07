-- desktop-that-never-starts
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- The guest answers "still starting" while its desktop controls or its browser
-- come up, and the host polls until a deadline. When the deadline passed the
-- host gave up without writing anything down, so the card went on saying
-- "Desktop controls are still starting" and the duck went on being told to ask
-- again - for as long as the machine stayed up, which on one whose browser
-- never comes back is forever.
--
-- This cannot be the computers.error column: housekeeping clears that on every
-- reading the provider answers, on the grounds that whatever went wrong is
-- over. A desktop that will not start is not over because the box is fine -
-- the box being fine is the situation.
ALTER TABLE computers ADD COLUMN desktop_failed INTEGER NOT NULL DEFAULT 0;
