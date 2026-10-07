-- Per-board display preferences are independent of workflow execution settings.
ALTER TABLE task_boards ADD COLUMN sort_order TEXT NOT NULL DEFAULT 'newest';
ALTER TABLE task_boards ADD COLUMN hide_done_after_days INTEGER;

CREATE TABLE task_completion(
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL
);

CREATE INDEX task_completion_company ON task_completion(company_id,completed_at);

INSERT INTO task_completion(task_id,company_id,completed_at)
SELECT t.id,t.company_id,COALESCE(
  (SELECT a.created
   FROM ticket_activity a, json_each(a.changes) ch
   WHERE a.company_id=t.company_id AND a.task_id=t.id
     AND json_extract(ch.value,'$.field')='Status'
     AND json_extract(ch.value,'$.after')='done'
   ORDER BY a.id DESC LIMIT 1),
  t.updated
)
FROM tasks t
WHERE t.status='done';

CREATE TRIGGER task_completion_insert AFTER INSERT ON tasks
WHEN NEW.status='done'
BEGIN
  INSERT INTO task_completion(task_id,company_id,completed_at)
  VALUES(NEW.id,NEW.company_id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER task_completion_status AFTER UPDATE OF status ON tasks
BEGIN
  INSERT INTO task_completion(task_id,company_id,completed_at)
  SELECT NEW.id,NEW.company_id,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NEW.status='done' AND OLD.status<>'done'
  ON CONFLICT(task_id) DO UPDATE SET completed_at=excluded.completed_at;
  DELETE FROM task_completion
  WHERE task_id=NEW.id AND NEW.status<>'done';
END;
