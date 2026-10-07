CREATE TABLE duck_work_plans (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  duck_id TEXT NOT NULL REFERENCES ducks(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  thread_id TEXT REFERENCES messages(id),
  task_id TEXT REFERENCES tasks(id),
  schedule_id TEXT,
  original_job_id TEXT NOT NULL REFERENCES jobs(id),
  original_message_id TEXT NOT NULL REFERENCES messages(id),
  original_request TEXT NOT NULL,
  goal TEXT NOT NULL CHECK(length(goal) BETWEEN 1 AND 1200),
  status TEXT NOT NULL CHECK(status IN ('active','paused','completed','cancelled')),
  summary TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX duck_work_plans_scope ON duck_work_plans(company_id,user_id,duck_id,conversation_id,thread_id,task_id,schedule_id,status,updated DESC);
CREATE TABLE duck_work_plan_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES duck_work_plans(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 500),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes) <= 1000),
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','blocked','completed','cancelled')),
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX duck_work_plan_items_plan ON duck_work_plan_items(plan_id,position);
