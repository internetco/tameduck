-- Personal Chief settings are separate from action-capable schedules.
CREATE TABLE chief_checkin_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  times TEXT NOT NULL DEFAULT '[540,900]',
  weekdays_only INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  next_at INTEGER,
  last_checked_at INTEGER,
  last_result TEXT,
  last_context_hash TEXT,
  updated TEXT NOT NULL,
  PRIMARY KEY(user_id,company_id)
);
CREATE TABLE chief_checkin_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  duck_id TEXT NOT NULL REFERENCES ducks(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  due INTEGER,
  context_hash TEXT NOT NULL,
  output_hash TEXT,
  summary TEXT NOT NULL DEFAULT '',
  dismissed INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL,
  created TEXT NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX chief_checkin_occurrence ON chief_checkin_runs(user_id,company_id,due) WHERE due IS NOT NULL;
ALTER TABLE jobs ADD COLUMN checkin INTEGER NOT NULL DEFAULT 0;
CREATE INDEX jobs_checkin_active ON jobs(company_id,user_id,checkin,status);

CREATE INDEX chief_checkin_history ON chief_checkin_runs(user_id,company_id,created);
CREATE INDEX chief_checkin_output ON chief_checkin_runs(user_id,company_id,output_hash);
