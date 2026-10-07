CREATE TABLE computer_proxy_sessions (
  id TEXT PRIMARY KEY,
  computer_id TEXT NOT NULL REFERENCES computers(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  duck_id TEXT NOT NULL REFERENCES ducks(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  state TEXT NOT NULL CHECK(state IN ('starting','enabled','blocked','unreachable','unknown','disabled','expired','failed','absent','lost')),
  started INTEGER NOT NULL,
  ended INTEGER,
  last_seen INTEGER,
  guest_upload_bytes INTEGER NOT NULL DEFAULT 0,
  guest_download_bytes INTEGER NOT NULL DEFAULT 0,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  exit_ip TEXT,
  last_error TEXT,
  finalized INTEGER NOT NULL DEFAULT 0,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX computer_proxy_one_active_per_computer
  ON computer_proxy_sessions(computer_id) WHERE ended IS NULL;
CREATE INDEX computer_proxy_sessions_job_active
  ON computer_proxy_sessions(job_id,ended);
CREATE INDEX computer_proxy_sessions_company_started
  ON computer_proxy_sessions(company_id,started);

CREATE TABLE computer_proxy_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES computer_proxy_sessions(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  duck_id TEXT NOT NULL REFERENCES ducks(id),
  computer_id TEXT NOT NULL REFERENCES computers(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  recorded INTEGER NOT NULL,
  upload_bytes INTEGER NOT NULL CHECK(upload_bytes>=0),
  download_bytes INTEGER NOT NULL CHECK(download_bytes>=0),
  guest_upload_bytes INTEGER NOT NULL CHECK(guest_upload_bytes>=0),
  guest_download_bytes INTEGER NOT NULL CHECK(guest_download_bytes>=0)
);
CREATE INDEX computer_proxy_usage_company_recorded
  ON computer_proxy_usage(company_id,recorded);
CREATE INDEX computer_proxy_usage_duck_recorded
  ON computer_proxy_usage(duck_id,recorded);
