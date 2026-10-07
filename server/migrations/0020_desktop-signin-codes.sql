-- A browser-authenticated secret must be typed into the requesting app.
-- Existing comparison-only requests expire instead of gaining new privileges.
ALTER TABLE desktop_signins ADD COLUMN mode TEXT NOT NULL DEFAULT 'comparison';
ALTER TABLE desktop_signins ADD COLUMN handoff_code_hash TEXT;
ALTER TABLE desktop_signins ADD COLUMN handoff_code_expires INTEGER;
ALTER TABLE desktop_signins ADD COLUMN handoff_attempts INTEGER NOT NULL DEFAULT 0;
