-- Short-lived browser approvals. Only the app knows the challenge verifier.
CREATE TABLE desktop_signins (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  code TEXT NOT NULL,
  expires INTEGER NOT NULL,
  approved_session_hash TEXT,
  approved_user_id TEXT,
  approved_company_id TEXT,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX desktop_signins_expiry ON desktop_signins(expires);
