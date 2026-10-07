-- company-logo
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- A company can upload one logo, shown wherever its letter tile is drawn
-- today. logo_mime is set only once a logo is stored, so it also answers
-- "does this company have a logo". logo_version goes up by one on every
-- upload or remove, so a screen can put it on the image's URL and the
-- browser fetches the new picture instead of the one it already cached.
ALTER TABLE companies ADD COLUMN logo_mime TEXT;
ALTER TABLE companies ADD COLUMN logo_version INTEGER NOT NULL DEFAULT 0;
