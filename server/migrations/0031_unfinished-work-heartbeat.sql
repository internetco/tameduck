ALTER TABLE company_work_limits ADD COLUMN auto_resume INTEGER NOT NULL DEFAULT 1 CHECK(auto_resume IN (0,1));
CREATE TABLE duck_auto_resume_overrides (
  duck_id TEXT PRIMARY KEY REFERENCES ducks(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  auto_resume INTEGER NOT NULL CHECK(auto_resume IN (0,1)),
  updated TEXT NOT NULL
);
-- Only enqueue opts new work in. Existing jobs and historical interruptions stay inert.
ALTER TABLE jobs ADD COLUMN recovery_root_job_id TEXT REFERENCES jobs(id);
CREATE INDEX jobs_recovery_root ON jobs(recovery_root_job_id);
CREATE TABLE unfinished_work (
  root_job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  current_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  state TEXT NOT NULL CHECK(state IN ('active','waiting','queued','held','needs_attention','completed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  next_attempt_at TEXT,
  reason TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  remaining_work TEXT NOT NULL DEFAULT '',
  original_request TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX unfinished_work_due ON unfinished_work(state,next_attempt_at);
CREATE INDEX unfinished_work_company ON unfinished_work(company_id,current_job_id);

ALTER TABLE job_work_finishes ADD COLUMN resume_policy TEXT NOT NULL DEFAULT 'automatic' CHECK(resume_policy IN ('automatic','hold'));

ALTER TABLE jobs ADD COLUMN automatic_recovery INTEGER NOT NULL DEFAULT 0 CHECK(automatic_recovery IN (0,1));
-- Durable enrollment starts with this migration, with no historical backfill.
-- An explicit later reassignment may opt an old open ticket in.
CREATE TABLE task_work_enrollment (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  enrolled_at TEXT NOT NULL
);
CREATE TRIGGER task_work_enroll_new AFTER INSERT ON tasks
WHEN NEW.assignee_id IS NOT NULL AND NEW.status='open'
BEGIN
  INSERT OR IGNORE INTO task_work_enrollment VALUES(NEW.id,NEW.company_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER task_work_enroll_assigned AFTER UPDATE OF assignee_id ON tasks
WHEN NEW.assignee_id IS NOT NULL AND NEW.assignee_id IS NOT OLD.assignee_id AND NEW.status='open'
BEGIN
  INSERT OR IGNORE INTO task_work_enrollment VALUES(NEW.id,NEW.company_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
