-- setup-first-screen-answered
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- Setting up a new company is two screens, and which one somebody was on was
-- kept only in their browser tab. So after answering the first, a new tab or
-- another device showed it again, under "We guessed some of this from your
-- email address" - over answers they had typed themselves.
--
-- Nothing already stored tells the two apart: a guess kept as it was is the
-- same name, the same clock, the same empty rules. So answering the first
-- screen now says when it was answered. Companies from before this stay empty,
-- because nobody can know whether their first screen was answered.
ALTER TABLE companies ADD COLUMN details_at TEXT;
