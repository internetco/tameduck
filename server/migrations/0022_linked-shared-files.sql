CREATE TABLE shared_files (
 id TEXT PRIMARY KEY,
 company_id TEXT NOT NULL REFERENCES companies(id),
 computer_id TEXT REFERENCES computers(id) ON DELETE SET NULL,
 source_box_id TEXT NOT NULL,
 duck_id TEXT NOT NULL REFERENCES ducks(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 task_id TEXT REFERENCES tasks(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 message_id TEXT NOT NULL REFERENCES messages(id),
 source_path TEXT NOT NULL,
 display_name TEXT NOT NULL,
 source_dev TEXT NOT NULL,
 source_ino TEXT NOT NULL,
 source_token TEXT NOT NULL,
 observed_token TEXT,
 observed_count INTEGER NOT NULL DEFAULT 0,
 missing_count INTEGER NOT NULL DEFAULT 0,
 current_upload_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
 archived INTEGER NOT NULL DEFAULT 0,
 archive_reason TEXT,
 created TEXT NOT NULL,
 updated TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 UNIQUE(company_id,computer_id,source_box_id,conversation_id,task_id,source_path)
);
CREATE INDEX shared_files_scan ON shared_files(computer_id,source_box_id,archived);
CREATE UNIQUE INDEX shared_files_identity ON shared_files(
 company_id,computer_id,source_box_id,conversation_id,COALESCE(task_id,''),source_path
);
CREATE INDEX shared_files_visible ON shared_files(company_id,conversation_id,archived);
CREATE TABLE shared_file_versions (
 shared_file_id TEXT NOT NULL REFERENCES shared_files(id) ON DELETE CASCADE,
 upload_id TEXT NOT NULL UNIQUE REFERENCES uploads(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL,
 created TEXT NOT NULL,
 PRIMARY KEY(shared_file_id,version)
);
CREATE INDEX shared_file_versions_latest ON shared_file_versions(shared_file_id,version DESC);
CREATE TABLE shared_file_exports (
 job_id TEXT NOT NULL REFERENCES jobs(id),
 call_id TEXT NOT NULL,
 shared_file_id TEXT NOT NULL REFERENCES shared_files(id),
 upload_id TEXT NOT NULL REFERENCES uploads(id),
 created TEXT NOT NULL,
 PRIMARY KEY(job_id,call_id)
);
