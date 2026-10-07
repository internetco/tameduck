CREATE INDEX jobs_accepted_updates ON jobs(steered_into,status);

-- Snapshot ticket updates only after a delivery has been acknowledged. This
-- table is separate from the bounded activity preview and keeps the original
-- accepted body even if the ticket text is later edited or archived.
CREATE TABLE duck_accepted_ticket_updates (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  activity_id INTEGER NOT NULL,
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  duck_id TEXT NOT NULL REFERENCES ducks(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  thread_id TEXT,
  task_id TEXT NOT NULL,
  schedule_id TEXT,
  author_user_id TEXT,
  body TEXT NOT NULL,
  created TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(job_id,activity_id)
);
CREATE INDEX duck_accepted_ticket_updates_scope
  ON duck_accepted_ticket_updates(company_id,user_id,duck_id,conversation_id,thread_id,task_id,schedule_id,job_id,created,activity_id);

-- Backfill deliveries confirmed before this migration.
INSERT OR IGNORE INTO duck_accepted_ticket_updates
  (job_id,activity_id,company_id,user_id,duck_id,conversation_id,thread_id,task_id,schedule_id,author_user_id,body,created,accepted_at)
SELECT d.job_id,d.activity_id,j.company_id,j.user_id,j.duck_id,j.conversation_id,
       j.thread_id,j.task_id,j.schedule_id,a.user_id,a.body,a.created,
       strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM ticket_reply_deliveries d
JOIN jobs j ON j.id=d.job_id
JOIN ticket_replies r ON r.activity_id=d.activity_id
JOIN ticket_activity a ON a.id=d.activity_id
WHERE j.task_id=r.task_id AND j.company_id=r.company_id
  AND a.task_id=r.task_id AND a.company_id=r.company_id;

CREATE TRIGGER duck_accepted_ticket_update_delivery
AFTER INSERT ON ticket_reply_deliveries
BEGIN
  INSERT OR IGNORE INTO duck_accepted_ticket_updates
    (job_id,activity_id,company_id,user_id,duck_id,conversation_id,thread_id,task_id,schedule_id,author_user_id,body,created,accepted_at)
  SELECT NEW.job_id,NEW.activity_id,j.company_id,j.user_id,j.duck_id,j.conversation_id,
         j.thread_id,j.task_id,j.schedule_id,a.user_id,a.body,a.created,
         strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM jobs j
  JOIN ticket_replies r ON r.activity_id=NEW.activity_id
  JOIN ticket_activity a ON a.id=NEW.activity_id
  WHERE j.id=NEW.job_id AND j.task_id=r.task_id AND j.company_id=r.company_id
    AND a.task_id=r.task_id AND a.company_id=r.company_id;
END;
