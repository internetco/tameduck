ALTER TABLE jobs ADD COLUMN control_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE job_work_finishes (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id),
  call_id TEXT NOT NULL,
  control_revision INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('completed','incomplete')),
  summary TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  remaining_work TEXT NOT NULL DEFAULT '',
  quiet INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);
