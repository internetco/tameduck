-- one-finish-one-line
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- One duck finishing one stage wrote two lines into the ticket feed. The
-- decision it recorded became "Submitted done", and the job going quiet a
-- moment later became "Duck work done" - same duck, same second, and usually
-- the same words, because a duck asked for one short answer puts it in both.
--
-- The reader drops the second of the pair, and to find the pair it needs to
-- know they belong to the same run. The decision entry had everything except
-- that: the job is on the workflow_runs row this trigger already reads.
DROP TRIGGER ticket_decision_activity;
CREATE TRIGGER ticket_decision_activity AFTER UPDATE OF decision,result,details ON workflow_runs
 WHEN NEW.decision IS NOT NULL AND (OLD.decision IS NOT NEW.decision OR OLD.result IS NOT NEW.result OR OLD.details IS NOT NEW.details) BEGIN
 INSERT INTO ticket_activity(company_id,task_id,kind,action,body,details,duck_id,job_id,source_key,created)
 VALUES(NEW.company_id,NEW.task_id,'work','Submitted '||replace(NEW.decision,'_',' '),NEW.result,NULLIF(NEW.details,''),NEW.duck_id,NEW.job_id,'decision:'||NEW.id||':'||lower(hex(randomblob(8))),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 END;

-- Entries already written keep their empty job_id: the run they came from is
-- still on record, so fill them in rather than leaving old tickets showing the
-- pair this change is here to stop.
-- source_key is 'decision:' (9 characters) then the run's id (36) then a
-- suffix, so the id is found by position and looked up on its primary key.
UPDATE ticket_activity SET job_id=(
  SELECT r.job_id FROM workflow_runs r WHERE r.id=substr(ticket_activity.source_key, 10, 36))
WHERE job_id IS NULL AND source_key LIKE 'decision:%';
