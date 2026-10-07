-- The structure production had on 22 September 2026, when migrations began:
-- every table, index and trigger, and none of the data. A new database starts
-- here. Production already had all of it, so it recorded this as adopted
-- instead of running it.
--
-- Each statement is copied exactly as SQLite stored it, which is why some are
-- laid out oddly: ALTER TABLE ... ADD COLUMN appends to the stored text. Left
-- out: SQLite's own tables, the tables full-text search makes for itself, and
-- the storage_* triggers, which storage.mjs rebuilds at every start.

-- 88 tables

CREATE TABLE companies (id TEXT PRIMARY KEY,name TEXT NOT NULL,rules TEXT NOT NULL DEFAULT '',auto_create INTEGER NOT NULL DEFAULT 1,paused INTEGER NOT NULL DEFAULT 0,billing_status TEXT NOT NULL DEFAULT 'staging',stripe_customer TEXT,stripe_subscription TEXT,created TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT '', onboarded_at TEXT);

CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password TEXT NOT NULL,recovery_hash TEXT,created TEXT NOT NULL);

CREATE TABLE memberships (company_id TEXT REFERENCES companies(id),user_id TEXT REFERENCES users(id),role TEXT NOT NULL,permissions TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(company_id,user_id));

CREATE TABLE sessions (token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),company_id TEXT REFERENCES companies(id),expires INTEGER NOT NULL);

CREATE TABLE ducks (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,role TEXT NOT NULL,emoji TEXT NOT NULL DEFAULT '🦆',color TEXT NOT NULL DEFAULT '#f4c65d',soul TEXT NOT NULL,identity TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',chief INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL, avatar TEXT, removed INTEGER NOT NULL DEFAULT 0);

CREATE TABLE conversations (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,kind TEXT NOT NULL,creator_id TEXT REFERENCES users(id),created TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, task_id TEXT);

CREATE TABLE conversation_members (conversation_id TEXT REFERENCES conversations(id),user_id TEXT REFERENCES users(id),PRIMARY KEY(conversation_id,user_id));

CREATE TABLE conversation_ducks (conversation_id TEXT REFERENCES conversations(id),duck_id TEXT REFERENCES ducks(id),PRIMARY KEY(conversation_id,duck_id));

CREATE TABLE messages (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),duck_id TEXT REFERENCES ducks(id),user_id TEXT REFERENCES users(id),body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'sent',created TEXT NOT NULL, thread_id TEXT REFERENCES messages(id), origin TEXT, needs_you TEXT);

CREATE TABLE inbox (message_id TEXT REFERENCES messages(id),user_id TEXT REFERENCES users(id),state TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(message_id,user_id));

CREATE TABLE tasks (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',assignee_id TEXT REFERENCES ducks(id),status TEXT NOT NULL DEFAULT 'open',priority TEXT NOT NULL DEFAULT 'normal',creator_id TEXT REFERENCES users(id),result TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE documents (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),title TEXT NOT NULL,content TEXT NOT NULL,duck_id TEXT REFERENCES ducks(id),user_id TEXT REFERENCES users(id),created TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE secrets (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,value TEXT NOT NULL,allowed_ducks TEXT NOT NULL DEFAULT '[]',created TEXT NOT NULL, group_id TEXT REFERENCES secret_groups(id) ON DELETE SET NULL, created_by_duck TEXT REFERENCES ducks(id),UNIQUE(company_id,name));

CREATE TABLE connections (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,url TEXT NOT NULL,secret_id TEXT REFERENCES secrets(id),allowed_ducks TEXT NOT NULL DEFAULT '[]',enabled INTEGER NOT NULL DEFAULT 1,tools TEXT NOT NULL DEFAULT '[]',created TEXT NOT NULL, provider_id TEXT, auth_type TEXT NOT NULL DEFAULT 'none', connection_status TEXT NOT NULL DEFAULT 'unchecked', checked_at TEXT, last_error TEXT);

CREATE TABLE jobs (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),user_id TEXT NOT NULL REFERENCES users(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),duck_id TEXT NOT NULL REFERENCES ducks(id),input_message_id TEXT REFERENCES messages(id),output_message_id TEXT REFERENCES messages(id),task_id TEXT REFERENCES tasks(id),status TEXT NOT NULL DEFAULT 'queued',error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL, steered_into TEXT, thread_id TEXT REFERENCES messages(id), resumed_control INTEGER NOT NULL DEFAULT 0, needs_you TEXT, schedule_id TEXT, schedule_title TEXT, schedule_summary TEXT, parent_job_id TEXT REFERENCES jobs(id), root_job_id TEXT REFERENCES jobs(id), stopped_by TEXT REFERENCES users(id));

CREATE TABLE approvals (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),job_id TEXT NOT NULL REFERENCES jobs(id),connection_id TEXT NOT NULL REFERENCES connections(id),tool TEXT NOT NULL,args TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',result TEXT,decided_by TEXT REFERENCES users(id),created TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE tool_receipts (job_id TEXT REFERENCES jobs(id),call_id TEXT,result TEXT NOT NULL,PRIMARY KEY(job_id,call_id));

CREATE TABLE invites (token_hash TEXT PRIMARY KEY,id TEXT NOT NULL,company_id TEXT NOT NULL REFERENCES companies(id),email TEXT NOT NULL,role TEXT NOT NULL,permissions TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL,accepted INTEGER NOT NULL DEFAULT 0);

CREATE TABLE audit (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),user_id TEXT,action TEXT NOT NULL,details TEXT NOT NULL,created TEXT NOT NULL);

CREATE TABLE billing_events (id TEXT PRIMARY KEY,created TEXT NOT NULL);

CREATE TABLE computer_settings(company_id TEXT PRIMARY KEY REFERENCES companies(id),enabled INTEGER NOT NULL DEFAULT 1,daily_minutes INTEGER NOT NULL DEFAULT 60);

CREATE TABLE duck_computer_access(duck_id TEXT PRIMARY KEY REFERENCES ducks(id),company_id TEXT NOT NULL REFERENCES companies(id),enabled INTEGER NOT NULL DEFAULT 0);

CREATE TABLE computers(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),duck_id TEXT NOT NULL UNIQUE REFERENCES ducks(id),box_id TEXT,state TEXT NOT NULL DEFAULT 'not_started',checkpoint TEXT NOT NULL DEFAULT '',screenshot_at TEXT,screenshot_path TEXT,last_activity INTEGER NOT NULL DEFAULT 0,viewer_until INTEGER NOT NULL DEFAULT 0,started_at INTEGER,archive_after TEXT,error TEXT,request_at INTEGER,bootstrapped INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL, stopped_reason TEXT, checkpoint_job_id TEXT, checkpoint_conversation_id TEXT, checkpoint_at TEXT, bootstrap_version TEXT);

CREATE TABLE computer_usage(id TEXT PRIMARY KEY,computer_id TEXT NOT NULL REFERENCES computers(id),company_id TEXT NOT NULL REFERENCES companies(id),started INTEGER NOT NULL,ended INTEGER);

CREATE TABLE computer_actions(id TEXT PRIMARY KEY,computer_id TEXT NOT NULL REFERENCES computers(id),job_id TEXT,user_id TEXT,tool TEXT NOT NULL,checkpoint TEXT NOT NULL,state TEXT NOT NULL,created TEXT NOT NULL, command TEXT);

CREATE TABLE skills(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',content TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE duck_skills(duck_id TEXT NOT NULL REFERENCES ducks(id),skill_id TEXT NOT NULL REFERENCES skills(id),PRIMARY KEY(duck_id,skill_id));

CREATE TABLE skill_versions(skill_id TEXT NOT NULL REFERENCES skills(id),version INTEGER NOT NULL,content TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(skill_id,version));

CREATE TABLE computer_captures(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),computer_id TEXT NOT NULL REFERENCES computers(id),caption TEXT NOT NULL,image TEXT NOT NULL,created TEXT NOT NULL);

CREATE TABLE message_artifacts(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),message_id TEXT NOT NULL REFERENCES messages(id),kind TEXT NOT NULL,reference_id TEXT NOT NULL,title TEXT NOT NULL,verb TEXT NOT NULL,created TEXT NOT NULL,UNIQUE(message_id,kind,reference_id));

CREATE TABLE secret_groups (id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL COLLATE NOCASE,created TEXT NOT NULL,UNIQUE(company_id,name));

CREATE TABLE connection_oauth (connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,data TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE mcp_oauth_flows (state_hash TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),session_hash TEXT NOT NULL,browser_hash TEXT NOT NULL,expires INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',payload TEXT NOT NULL);

CREATE TABLE storage_items(
    source TEXT NOT NULL,object_id TEXT NOT NULL,company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    category TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('workspace','supporting')),
    bytes INTEGER NOT NULL CHECK(bytes>=0),item_count INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,PRIMARY KEY(source,object_id));

CREATE TABLE storage_scans(company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      checked_at TEXT NOT NULL);

CREATE TABLE storage_snapshots(company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      period TEXT NOT NULL,policy TEXT NOT NULL,observed_at TEXT NOT NULL,files_checked_at TEXT,
      workspace_bytes INTEGER NOT NULL,supporting_bytes INTEGER NOT NULL,breakdown TEXT NOT NULL,
      PRIMARY KEY(company_id,period,policy));

CREATE TABLE storage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);

CREATE TABLE message_reads(company_id TEXT NOT NULL REFERENCES companies(id),message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),created TEXT NOT NULL,PRIMARY KEY(message_id,user_id));

CREATE TABLE human_directs(company_id TEXT NOT NULL REFERENCES companies(id),user_low TEXT NOT NULL REFERENCES users(id),user_high TEXT NOT NULL REFERENCES users(id),conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),PRIMARY KEY(company_id,user_low,user_high));

CREATE TABLE computer_control(computer_id TEXT PRIMARY KEY REFERENCES computers(id),company_id TEXT NOT NULL REFERENCES companies(id),user_id TEXT NOT NULL REFERENCES users(id),session_hash TEXT NOT NULL,expires INTEGER NOT NULL,started INTEGER NOT NULL,generation TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'preparing', phase TEXT);

CREATE TABLE task_boards(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',auto_advance INTEGER NOT NULL DEFAULT 1,enabled INTEGER NOT NULL DEFAULT 1,legacy INTEGER NOT NULL DEFAULT 0,creator_id TEXT REFERENCES users(id),created TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE board_columns(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),board_id TEXT NOT NULL REFERENCES task_boards(id),name TEXT NOT NULL,position INTEGER NOT NULL,duck_id TEXT REFERENCES ducks(id),instructions TEXT NOT NULL DEFAULT '',approvers TEXT NOT NULL DEFAULT '[]',wait_for_ducks TEXT NOT NULL DEFAULT '[]',review_in_order INTEGER NOT NULL DEFAULT 1,retired INTEGER NOT NULL DEFAULT 0);

CREATE TABLE board_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id),company_id TEXT NOT NULL REFERENCES companies(id),board_id TEXT NOT NULL REFERENCES task_boards(id),column_id TEXT NOT NULL REFERENCES board_columns(id),revision INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'ready',runner_id TEXT NOT NULL REFERENCES users(id),worker_result TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',updated TEXT NOT NULL, worker_details TEXT NOT NULL DEFAULT '', last_checked INTEGER NOT NULL DEFAULT 0);

CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),task_id TEXT NOT NULL REFERENCES tasks(id),column_id TEXT NOT NULL REFERENCES board_columns(id),revision INTEGER NOT NULL,duck_id TEXT NOT NULL REFERENCES ducks(id),role TEXT NOT NULL,job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),decision TEXT,result TEXT NOT NULL DEFAULT '',created TEXT NOT NULL, fingerprint TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '',UNIQUE(task_id,column_id,revision,duck_id,role));

CREATE TABLE workflow_history(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),task_id TEXT NOT NULL REFERENCES tasks(id),column_id TEXT NOT NULL REFERENCES board_columns(id),revision INTEGER NOT NULL,action TEXT NOT NULL,summary TEXT NOT NULL,created TEXT NOT NULL);

CREATE TABLE ticket_activity(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 company_id TEXT NOT NULL REFERENCES companies(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 kind TEXT NOT NULL, action TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', changes TEXT NOT NULL DEFAULT '[]',
 user_id TEXT REFERENCES users(id), duck_id TEXT REFERENCES ducks(id),
 source_key TEXT UNIQUE, created TEXT NOT NULL
, job_id TEXT, document_id TEXT, details TEXT, upload_id TEXT, consultation_id TEXT);

CREATE TABLE ai_credentials(company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,provider TEXT NOT NULL,encrypted_key TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(company_id,provider));

CREATE TABLE ai_defaults(company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,provider TEXT NOT NULL,model TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE duck_models(duck_id TEXT PRIMARY KEY REFERENCES ducks(id) ON DELETE CASCADE,company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,provider TEXT NOT NULL,model TEXT NOT NULL);

CREATE TABLE job_ai(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,company_id TEXT NOT NULL, message_id TEXT NOT NULL,requested_provider TEXT NOT NULL,requested_model TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,fallback_reason TEXT,trace TEXT);

CREATE TABLE skill_proposals (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  job_id TEXT NOT NULL REFERENCES jobs(id), user_id TEXT NOT NULL REFERENCES users(id),
  duck_id TEXT NOT NULL REFERENCES ducks(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
  thread_id TEXT, message_id TEXT REFERENCES messages(id), operation TEXT NOT NULL,
  payload TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  replaces_id TEXT, result_skill_id TEXT, decided_by TEXT REFERENCES users(id), feedback TEXT,
  created TEXT NOT NULL, updated TEXT NOT NULL, expires TEXT NOT NULL
);

CREATE TABLE skill_catalog_installs(company_id TEXT NOT NULL REFERENCES companies(id),catalog_id TEXT NOT NULL,skill_id TEXT NOT NULL UNIQUE REFERENCES skills(id) ON DELETE CASCADE,publisher TEXT NOT NULL,category TEXT NOT NULL,source_url TEXT NOT NULL,license TEXT NOT NULL,revision TEXT NOT NULL,installed TEXT NOT NULL,PRIMARY KEY(company_id,catalog_id));

CREATE TABLE human_wait_settings(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_minutes INTEGER NOT NULL DEFAULT 10 CHECK(default_minutes BETWEEN 1 AND 15),
  updated TEXT NOT NULL
);

CREATE TABLE human_wait_duck_overrides(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  duck_id TEXT NOT NULL REFERENCES ducks(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  minutes INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND 15),
  updated TEXT NOT NULL,
  PRIMARY KEY(user_id, duck_id)
);

CREATE TABLE human_requests(
 id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
 computer_id TEXT NOT NULL REFERENCES computers(id), duck_id TEXT NOT NULL REFERENCES ducks(id),
 job_id TEXT REFERENCES jobs(id), user_id TEXT NOT NULL REFERENCES users(id),
 conversation_id TEXT REFERENCES conversations(id), message_id TEXT REFERENCES messages(id),
 kind TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL, checkpoint TEXT NOT NULL,
 fields TEXT NOT NULL DEFAULT '[]', binding TEXT, status TEXT NOT NULL,
 expires INTEGER NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL,
 control_generation TEXT, outcome TEXT);

CREATE TABLE board_proposals (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  job_id TEXT NOT NULL REFERENCES jobs(id), user_id TEXT NOT NULL REFERENCES users(id),
  duck_id TEXT NOT NULL REFERENCES ducks(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
  thread_id TEXT, message_id TEXT REFERENCES messages(id), board_id TEXT REFERENCES task_boards(id),
  operation TEXT NOT NULL, payload TEXT NOT NULL, base TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', replaces_id TEXT, result_board_id TEXT, grant_id TEXT,
  decided_by TEXT REFERENCES users(id), feedback TEXT,
  created TEXT NOT NULL, updated TEXT NOT NULL, expires TEXT NOT NULL
);

CREATE TABLE board_grants (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  board_id TEXT NOT NULL REFERENCES task_boards(id), granted_by TEXT NOT NULL REFERENCES users(id),
  proposal_id TEXT, created TEXT NOT NULL, revoked_by TEXT REFERENCES users(id), revoked_at TEXT
);

CREATE TABLE uploads(id TEXT PRIMARY KEY,company_id TEXT NOT NULL REFERENCES companies(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),user_id TEXT REFERENCES users(id),message_id TEXT REFERENCES messages(id),name TEXT NOT NULL,mime TEXT NOT NULL,file_group TEXT NOT NULL,inline INTEGER NOT NULL DEFAULT 0,size INTEGER NOT NULL,stored_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,created TEXT NOT NULL);

CREATE TABLE upload_notices(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,upload_id TEXT NOT NULL,company_id TEXT NOT NULL REFERENCES companies(id),duck_id TEXT REFERENCES ducks(id),name TEXT NOT NULL,reason TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(message_id,upload_id));

CREATE TABLE duck_secret_access(duck_id TEXT PRIMARY KEY REFERENCES ducks(id),company_id TEXT NOT NULL REFERENCES companies(id),enabled INTEGER NOT NULL DEFAULT 1);

CREATE TABLE duck_note_access(duck_id TEXT PRIMARY KEY REFERENCES ducks(id),company_id TEXT NOT NULL REFERENCES companies(id),enabled INTEGER NOT NULL DEFAULT 1);

CREATE TABLE schedules(
 id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
 title TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
 duck_id TEXT NOT NULL REFERENCES ducks(id),
 repeat TEXT NOT NULL, at_minute INTEGER, on_day INTEGER,
 timezone TEXT NOT NULL, next_at INTEGER,
 paused INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0,
 runner_id TEXT NOT NULL REFERENCES users(id),
 creator_id TEXT NOT NULL REFERENCES users(id),
 last_fired_at INTEGER, created TEXT NOT NULL, updated TEXT NOT NULL, every_minutes INTEGER, from_minute INTEGER, to_minute INTEGER, weekdays_only INTEGER NOT NULL DEFAULT 0, board_id TEXT REFERENCES task_boards(id), incident_task_id TEXT REFERENCES tasks(id), paused_reason TEXT NOT NULL DEFAULT '');

CREATE TABLE schedule_runs(
 id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
 schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
 due INTEGER NOT NULL, outcome TEXT NOT NULL,
 task_id TEXT REFERENCES tasks(id), job_id TEXT REFERENCES jobs(id),
 note TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0);

CREATE TABLE owner_ai_credentials(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider TEXT NOT NULL,encrypted_key TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(user_id,provider));

CREATE TABLE owner_ai_defaults(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,provider TEXT NOT NULL,model TEXT NOT NULL,updated TEXT NOT NULL);

CREATE TABLE schedule_proposals (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
  job_id TEXT NOT NULL REFERENCES jobs(id), user_id TEXT NOT NULL REFERENCES users(id),
  duck_id TEXT NOT NULL REFERENCES ducks(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
  thread_id TEXT, message_id TEXT REFERENCES messages(id),
  payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  schedule_id TEXT REFERENCES schedules(id), decided_by TEXT REFERENCES users(id),
  feedback TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
, expires TEXT, replaces_id TEXT);

CREATE TABLE duck_schedule_access (
  duck_id TEXT PRIMARY KEY REFERENCES ducks(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id), enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE terminal_output(action_id TEXT PRIMARY KEY,stdout TEXT NOT NULL DEFAULT '',stderr TEXT NOT NULL DEFAULT '',updated TEXT NOT NULL);

CREATE TABLE ticket_replies(
 activity_id INTEGER PRIMARY KEY REFERENCES ticket_activity(id),
 company_id TEXT NOT NULL, task_id TEXT NOT NULL, user_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', job_id TEXT, message TEXT NOT NULL,
 created INTEGER NOT NULL
);

CREATE TABLE ticket_reply_deliveries(activity_id INTEGER NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(activity_id,job_id));

CREATE TABLE ticket_reply_checks(
 job_id TEXT PRIMARY KEY REFERENCES jobs(id), company_id TEXT NOT NULL,
 task_id TEXT NOT NULL, column_id TEXT, revision INTEGER,
 action TEXT, message TEXT NOT NULL DEFAULT '', applied INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE document_conversations(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,PRIMARY KEY(document_id,conversation_id));

CREATE TABLE computer_file_exports(
 upload_id TEXT PRIMARY KEY REFERENCES uploads(id) ON DELETE CASCADE,
 company_id TEXT NOT NULL REFERENCES companies(id),job_id TEXT NOT NULL REFERENCES jobs(id),
 call_id TEXT NOT NULL,duck_id TEXT NOT NULL REFERENCES ducks(id),created TEXT NOT NULL,
 UNIQUE(job_id,call_id)
);

CREATE TABLE task_uploads(
 upload_id TEXT PRIMARY KEY REFERENCES uploads(id) ON DELETE CASCADE,
 company_id TEXT NOT NULL REFERENCES companies(id),task_id TEXT NOT NULL REFERENCES tasks(id),created TEXT NOT NULL
);

CREATE TABLE sign_in_links(
 token_hash TEXT PRIMARY KEY,
 email TEXT NOT NULL,
 created INTEGER NOT NULL,
 expires INTEGER NOT NULL,
 used INTEGER NOT NULL DEFAULT 0);

CREATE TABLE message_artifact_changes(artifact_id TEXT NOT NULL REFERENCES message_artifacts(id) ON DELETE CASCADE,field_key TEXT NOT NULL,label TEXT NOT NULL,before_value TEXT NOT NULL,after_value TEXT NOT NULL,PRIMARY KEY(artifact_id,field_key));

CREATE TABLE duck_contact_policies(
  duck_id TEXT PRIMARY KEY REFERENCES ducks(id), company_id TEXT NOT NULL REFERENCES companies(id),
  mode TEXT NOT NULL, allowed_duck_ids TEXT NOT NULL DEFAULT '[]', chief_can_manage INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1, updated_by_user_id TEXT REFERENCES users(id),
  updated_by_duck_id TEXT REFERENCES ducks(id), updated TEXT NOT NULL
, max_requests_per_task INTEGER, max_parallel_requests INTEGER);

CREATE TABLE duck_consultations(
 id TEXT PRIMARY KEY,
 company_id TEXT NOT NULL REFERENCES companies(id),
 root_job_id TEXT NOT NULL REFERENCES jobs(id),
 parent_job_id TEXT NOT NULL REFERENCES jobs(id),
 child_job_id TEXT UNIQUE REFERENCES jobs(id),
 from_duck_id TEXT NOT NULL REFERENCES ducks(id),
 to_duck_id TEXT NOT NULL REFERENCES ducks(id),
 task_id TEXT REFERENCES tasks(id),
 call_id TEXT NOT NULL,
 question TEXT NOT NULL,
 context TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'waiting',
 answer TEXT,
 error TEXT,
 deadline INTEGER NOT NULL,
 created TEXT NOT NULL,
 updated TEXT NOT NULL, timeout_ms INTEGER NOT NULL DEFAULT 1800000,
 UNIQUE(parent_job_id,call_id)
);

CREATE TABLE duck_task_lineage(
 task_id TEXT PRIMARY KEY REFERENCES tasks(id),
 company_id TEXT NOT NULL REFERENCES companies(id),
 created_by_job_id TEXT NOT NULL REFERENCES jobs(id),
 created_by_duck_id TEXT NOT NULL REFERENCES ducks(id),
 created TEXT NOT NULL
);

CREATE TABLE computer_limit_overrides(
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  starts_per_minute INTEGER CHECK(starts_per_minute > 0),
  starts_per_hour INTEGER CHECK(starts_per_hour > 0),
  starts_per_day INTEGER CHECK(starts_per_day > 0),
  running_seconds_per_month INTEGER CHECK(running_seconds_per_month > 0),
  note TEXT NOT NULL DEFAULT '',
  updated TEXT NOT NULL);

CREATE TABLE computer_periods(
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL);

CREATE TABLE computer_limit_notes(
  company_id TEXT NOT NULL REFERENCES companies(id),
  period_start INTEGER NOT NULL,
  threshold INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY(company_id, period_start, threshold));

CREATE VIRTUAL TABLE activity_recall_fts USING fts5(
    company_id UNINDEXED, source_type UNINDEXED, source_id UNINDEXED, text,
    tokenize='unicode61 remove_diacritics 2'
  );

CREATE TABLE activity_recall_search_keys(
    company_id TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
    fts_rowid INTEGER NOT NULL UNIQUE,
    PRIMARY KEY(company_id,source_type,source_id)
  );

CREATE TABLE activity_recall_index_meta(version INTEGER NOT NULL);

CREATE TABLE email_settings(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  waiting INTEGER NOT NULL DEFAULT 1,
  decisions INTEGER NOT NULL DEFAULT 1,
  company INTEGER NOT NULL DEFAULT 1,
  updated TEXT NOT NULL);

CREATE TABLE email_sent(
  key TEXT PRIMARY KEY,
  created TEXT NOT NULL);

CREATE TABLE presence(
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY(company_id, user_id));

-- 37 indexes

CREATE UNIQUE INDEX chief_per_company ON ducks(company_id) WHERE chief=1;

CREATE INDEX messages_conversation ON messages(conversation_id,created);

CREATE INDEX jobs_status ON jobs(status,created);

CREATE UNIQUE INDEX computers_provider_box ON computers(box_id) WHERE box_id IS NOT NULL;

CREATE UNIQUE INDEX one_catalog_connection ON connections(company_id,provider_id) WHERE provider_id IS NOT NULL;

CREATE INDEX storage_items_company ON storage_items(company_id,scope,category);

CREATE INDEX messages_thread ON messages(conversation_id,thread_id,created);

CREATE INDEX board_tasks_board ON board_tasks(board_id,column_id);

CREATE INDEX ticket_activity_task ON ticket_activity(company_id,task_id,id);

CREATE INDEX job_ai_message ON job_ai(message_id,company_id);

CREATE INDEX skill_proposals_company ON skill_proposals(company_id, created);

CREATE INDEX human_wait_duck_overrides_scope
  ON human_wait_duck_overrides(user_id, company_id);

CREATE INDEX board_proposals_company ON board_proposals(company_id, created);

CREATE UNIQUE INDEX board_grants_active ON board_grants(board_id) WHERE revoked_at IS NULL;

CREATE INDEX uploads_conversation ON uploads(company_id,conversation_id,created);

CREATE INDEX uploads_message ON uploads(message_id);

CREATE INDEX ticket_activity_document ON ticket_activity(company_id,task_id,document_id) WHERE document_id IS NOT NULL;

CREATE INDEX schedules_due ON schedules(next_at) WHERE paused=0;

CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule_id,created);

CREATE INDEX schedule_proposals_company ON schedule_proposals(company_id, created);

CREATE INDEX computer_actions_by_computer ON computer_actions(computer_id);

CREATE INDEX ticket_replies_pending ON ticket_replies(state,task_id);

CREATE INDEX task_uploads_task ON task_uploads(company_id,task_id,created);

CREATE INDEX sign_in_links_email ON sign_in_links(email,created);

CREATE INDEX duck_contact_policies_company ON duck_contact_policies(company_id);

CREATE INDEX duck_consultations_parent ON duck_consultations(parent_job_id,created);

CREATE INDEX duck_consultations_child ON duck_consultations(child_job_id);

CREATE INDEX duck_consultations_task ON duck_consultations(company_id,task_id,created);

CREATE INDEX computer_usage_company_started_ended ON computer_usage(company_id, started, ended);

CREATE INDEX messages_company_activity ON messages(company_id,created,id);

CREATE INDEX jobs_company_activity ON jobs(company_id,updated,id);

CREATE INDEX documents_company_activity ON documents(company_id,updated,id);

CREATE INDEX artifacts_company_activity ON message_artifacts(company_id,created,id);

CREATE INDEX uploads_company_activity ON uploads(company_id,created,id);

CREATE INDEX captures_company_activity ON computer_captures(company_id,created,id);

CREATE INDEX jobs_output_message ON jobs(output_message_id);

CREATE UNIQUE INDEX human_request_computer_hold ON human_requests(computer_id)
 WHERE status NOT IN ('completed','cancelled','parked');

-- 27 triggers

CREATE TRIGGER ticket_created_activity AFTER INSERT ON tasks BEGIN
 INSERT INTO ticket_activity(company_id,task_id,kind,action,user_id,source_key,created)
 VALUES(NEW.company_id,NEW.id,'change','Created ticket',NEW.creator_id,'created:'||NEW.id,NEW.created);
END;

CREATE TRIGGER ticket_fields_activity AFTER UPDATE OF title,description,priority,assignee_id,status,result ON tasks
WHEN OLD.title IS NOT NEW.title OR OLD.description IS NOT NEW.description OR OLD.priority IS NOT NEW.priority OR OLD.assignee_id IS NOT NEW.assignee_id OR OLD.status IS NOT NEW.status OR OLD.result IS NOT NEW.result
BEGIN
 INSERT INTO ticket_activity(company_id,task_id,kind,action,changes,created)
 SELECT NEW.company_id,NEW.id,'change','Updated ticket',json_group_array(json_object('field',field,'before',before,'after',after)),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM (
 SELECT 'Title' field,OLD.title before,NEW.title after WHERE OLD.title IS NOT NEW.title
 UNION ALL SELECT 'Description',OLD.description,NEW.description WHERE OLD.description IS NOT NEW.description
 UNION ALL SELECT 'Priority',OLD.priority,NEW.priority WHERE OLD.priority IS NOT NEW.priority
 UNION ALL SELECT 'Assigned duck', (SELECT name FROM ducks WHERE id=OLD.assignee_id),(SELECT name FROM ducks WHERE id=NEW.assignee_id) WHERE OLD.assignee_id IS NOT NEW.assignee_id
 UNION ALL SELECT 'Status',OLD.status,NEW.status WHERE OLD.status IS NOT NEW.status
 UNION ALL SELECT 'Result',OLD.result,NEW.result WHERE OLD.result IS NOT NEW.result);
END;

CREATE TRIGGER ticket_stage_activity AFTER UPDATE OF column_id,state ON board_tasks
 WHEN OLD.column_id IS NOT NEW.column_id OR OLD.state IS NOT NEW.state BEGIN
 INSERT INTO ticket_activity(company_id,task_id,kind,action,changes,created)
 SELECT NEW.company_id,NEW.task_id,'change','Updated workflow',json_group_array(json_object('field',field,'before',before,'after',after)),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM (
 SELECT 'Stage' field,(SELECT name FROM board_columns WHERE id=OLD.column_id) before,(SELECT name FROM board_columns WHERE id=NEW.column_id) after WHERE OLD.column_id IS NOT NEW.column_id
 UNION ALL SELECT 'Progress',OLD.state,NEW.state WHERE OLD.state IS NOT NEW.state);
 END;

CREATE TRIGGER ticket_history_activity AFTER INSERT ON workflow_history WHEN NEW.action<>'Created' BEGIN
 INSERT OR IGNORE INTO ticket_activity(company_id,task_id,kind,action,body,source_key,created)
 VALUES(NEW.company_id,NEW.task_id,'work',NEW.action,NEW.summary,'history:'||NEW.id,NEW.created);
 END;

CREATE TRIGGER ticket_job_activity AFTER UPDATE OF status ON jobs
WHEN NEW.task_id IS NOT NULL AND OLD.status IS NOT NEW.status
BEGIN
 INSERT INTO ticket_activity(company_id,task_id,kind,action,body,duck_id,job_id,created)
 VALUES(NEW.company_id,NEW.task_id,'work','Duck work '||replace(NEW.status,'_',' '),CASE WHEN NEW.status IN ('failed','error','cancelled') THEN coalesce(NEW.error,'') WHEN NEW.status='done' THEN coalesce((SELECT body FROM messages WHERE id=NEW.output_message_id),'') ELSE '' END,NEW.duck_id,NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER ticket_decision_activity AFTER UPDATE OF decision,result,details ON workflow_runs
 WHEN NEW.decision IS NOT NULL AND (OLD.decision IS NOT NEW.decision OR OLD.result IS NOT NEW.result OR OLD.details IS NOT NEW.details) BEGIN
 INSERT INTO ticket_activity(company_id,task_id,kind,action,body,details,duck_id,source_key,created)
 VALUES(NEW.company_id,NEW.task_id,'work','Submitted '||replace(NEW.decision,'_',' '),NEW.result,NULLIF(NEW.details,''),NEW.duck_id,'decision:'||NEW.id||':'||lower(hex(randomblob(8))),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 END;

CREATE TRIGGER activity_recall_messages_insert AFTER INSERT ON messages BEGIN
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'message',CAST(NEW.id AS TEXT),coalesce(NEW.body,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'message',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_messages_update AFTER UPDATE ON messages BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='message' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='message' AND source_id=CAST(OLD.id AS TEXT);
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'message',CAST(NEW.id AS TEXT),coalesce(NEW.body,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'message',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_messages_delete AFTER DELETE ON messages BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='message' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='message' AND source_id=CAST(OLD.id AS TEXT);
    END;

CREATE TRIGGER activity_recall_tasks_insert AFTER INSERT ON tasks BEGIN
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'task',CAST(NEW.id AS TEXT),coalesce(NEW.title,'')||' '||coalesce(NEW.description,'')||' '||coalesce(NEW.result,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'task',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_tasks_update AFTER UPDATE ON tasks BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='task' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='task' AND source_id=CAST(OLD.id AS TEXT);
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'task',CAST(NEW.id AS TEXT),coalesce(NEW.title,'')||' '||coalesce(NEW.description,'')||' '||coalesce(NEW.result,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'task',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_tasks_delete AFTER DELETE ON tasks BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='task' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='task' AND source_id=CAST(OLD.id AS TEXT);
    END;

CREATE TRIGGER activity_recall_documents_insert AFTER INSERT ON documents BEGIN
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'document',CAST(NEW.id AS TEXT),coalesce(NEW.title,'')||' '||coalesce(NEW.content,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'document',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_documents_update AFTER UPDATE ON documents BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='document' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='document' AND source_id=CAST(OLD.id AS TEXT);
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'document',CAST(NEW.id AS TEXT),coalesce(NEW.title,'')||' '||coalesce(NEW.content,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'document',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_documents_delete AFTER DELETE ON documents BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='document' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='document' AND source_id=CAST(OLD.id AS TEXT);
    END;

CREATE TRIGGER activity_recall_uploads_insert AFTER INSERT ON uploads BEGIN
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'upload',CAST(NEW.id AS TEXT),coalesce(NEW.name,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'upload',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_uploads_update AFTER UPDATE ON uploads BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='upload' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='upload' AND source_id=CAST(OLD.id AS TEXT);
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'upload',CAST(NEW.id AS TEXT),coalesce(NEW.name,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'upload',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_uploads_delete AFTER DELETE ON uploads BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='upload' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='upload' AND source_id=CAST(OLD.id AS TEXT);
    END;

CREATE TRIGGER activity_recall_message_artifacts_insert AFTER INSERT ON message_artifacts BEGIN
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'artifact',CAST(NEW.id AS TEXT),coalesce(NEW.verb,'')||' '||coalesce(NEW.title,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'artifact',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_message_artifacts_update AFTER UPDATE ON message_artifacts BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='artifact' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='artifact' AND source_id=CAST(OLD.id AS TEXT);
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'artifact',CAST(NEW.id AS TEXT),coalesce(NEW.verb,'')||' '||coalesce(NEW.title,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'artifact',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_message_artifacts_delete AFTER DELETE ON message_artifacts BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='artifact' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='artifact' AND source_id=CAST(OLD.id AS TEXT);
    END;

CREATE TRIGGER activity_recall_computer_captures_insert AFTER INSERT ON computer_captures BEGIN
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'capture',CAST(NEW.id AS TEXT),coalesce(NEW.caption,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'capture',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_computer_captures_update AFTER UPDATE ON computer_captures BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='capture' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='capture' AND source_id=CAST(OLD.id AS TEXT);
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'capture',CAST(NEW.id AS TEXT),coalesce(NEW.caption,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'capture',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_computer_captures_delete AFTER DELETE ON computer_captures BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='capture' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='capture' AND source_id=CAST(OLD.id AS TEXT);
    END;

CREATE TRIGGER activity_recall_ticket_activity_insert AFTER INSERT ON ticket_activity BEGIN
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'ticket',CAST(NEW.id AS TEXT),coalesce(NEW.action,'')||' '||coalesce(NEW.body,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'ticket',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_ticket_activity_update AFTER UPDATE ON ticket_activity BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='ticket' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='ticket' AND source_id=CAST(OLD.id AS TEXT);
      INSERT INTO activity_recall_fts(company_id,source_type,source_id,text)
      VALUES(NEW.company_id,'ticket',CAST(NEW.id AS TEXT),coalesce(NEW.action,'')||' '||coalesce(NEW.body,''));
      INSERT INTO activity_recall_search_keys(company_id,source_type,source_id,fts_rowid)
      VALUES(NEW.company_id,'ticket',CAST(NEW.id AS TEXT),last_insert_rowid());
    END;

CREATE TRIGGER activity_recall_ticket_activity_delete AFTER DELETE ON ticket_activity BEGIN
      DELETE FROM activity_recall_fts WHERE rowid=(SELECT fts_rowid FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='ticket' AND source_id=CAST(OLD.id AS TEXT));
      DELETE FROM activity_recall_search_keys
        WHERE company_id=OLD.company_id AND source_type='ticket' AND source_id=CAST(OLD.id AS TEXT);
    END;
