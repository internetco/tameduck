-- Company work duration is absent until explicitly changed; the application then
-- uses its legacy RUN_LIMIT_MINUTES value (30 minutes by default).
CREATE TABLE company_work_limits (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  run_minutes INTEGER NOT NULL CHECK(run_minutes BETWEEN 0 AND 10080),
  updated TEXT NOT NULL
);
CREATE TABLE duck_work_limit_overrides (
  duck_id TEXT PRIMARY KEY REFERENCES ducks(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_minutes INTEGER NOT NULL CHECK(run_minutes BETWEEN 0 AND 10080),
  updated TEXT NOT NULL
);
CREATE INDEX duck_work_limit_overrides_company ON duck_work_limit_overrides(company_id);

ALTER TABLE jobs ADD COLUMN work_limit_minutes INTEGER CHECK(work_limit_minutes BETWEEN 0 AND 10080);
ALTER TABLE jobs ADD COLUMN work_used_ms INTEGER NOT NULL DEFAULT 0 CHECK(work_used_ms >= 0);
ALTER TABLE jobs ADD COLUMN work_active_since_ms INTEGER;
-- Existing consultations retain their original wall-clock timeout. New ones
-- use the helper job's captured work budget; explicit test/admin timeouts can
-- still use the original deadline path.
ALTER TABLE duck_consultations ADD COLUMN work_limit_mode INTEGER NOT NULL DEFAULT 0 CHECK(work_limit_mode IN (0,1));

-- These runs began before this feature existed. Keep their legacy 30-minute
-- policy when they resume instead of adopting a newly selected company limit.
UPDATE jobs SET work_limit_minutes=30
WHERE status IN ('waiting_human','waiting_consultation')
   OR (status='queued' AND EXISTS (SELECT 1 FROM job_ai WHERE job_ai.job_id=jobs.id));

-- A transition out of running settles the active segment immediately. Human
-- and helper waits do not consume work time. Crash recovery has no exact
-- process-stop timestamp, so its interrupted transition keeps the last
-- checkpoint instead of charging the time while the server was offline.
CREATE TRIGGER jobs_work_time_settle
AFTER UPDATE OF status ON jobs
WHEN OLD.status='running' AND NEW.status<>'running' AND OLD.work_active_since_ms IS NOT NULL
BEGIN
  UPDATE jobs SET
    work_used_ms=OLD.work_used_ms +
      CASE WHEN NEW.status='interrupted' THEN 0
           ELSE max(0, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) - OLD.work_active_since_ms) END,
    work_active_since_ms=NULL
  WHERE id=NEW.id;
END;
