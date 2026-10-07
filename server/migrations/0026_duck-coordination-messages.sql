CREATE TABLE duck_messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 company_id TEXT NOT NULL REFERENCES companies(id),
 from_job_id TEXT NOT NULL REFERENCES jobs(id),
 root_job_id TEXT NOT NULL REFERENCES jobs(id),
 from_duck_id TEXT NOT NULL REFERENCES ducks(id),
 from_duck_name TEXT NOT NULL,
 to_duck_id TEXT NOT NULL REFERENCES ducks(id),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
 created TEXT NOT NULL,
 reply_to TEXT REFERENCES duck_messages(id),
 source_conversation_id TEXT NOT NULL REFERENCES conversations(id),
 source_task_id TEXT REFERENCES tasks(id),
 source_human_audience TEXT NOT NULL,
 source_duck_audience TEXT NOT NULL,
 delivered_job_id TEXT REFERENCES jobs(id),
 delivered_at TEXT,
 call_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 UNIQUE(from_job_id,call_id)
);
CREATE INDEX duck_messages_pending ON duck_messages(company_id,to_duck_id,delivered_job_id,seq);
CREATE INDEX duck_messages_budget ON duck_messages(root_job_id,from_duck_id);
CREATE INDEX duck_messages_delivery ON duck_messages(delivered_job_id,seq);
