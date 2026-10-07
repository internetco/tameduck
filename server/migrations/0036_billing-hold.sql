-- Whether billing has paused a company. The application reads it; this
-- edition has no billing, so it stays 0.
ALTER TABLE companies ADD COLUMN billing_hold INTEGER NOT NULL DEFAULT 0;
