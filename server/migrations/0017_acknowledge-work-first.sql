ALTER TABLE jobs ADD COLUMN acknowledgement TEXT;
ALTER TABLE jobs ADD COLUMN acknowledged_at TEXT;
ALTER TABLE jobs ADD COLUMN acknowledgement_suppressed INTEGER NOT NULL DEFAULT 0;
