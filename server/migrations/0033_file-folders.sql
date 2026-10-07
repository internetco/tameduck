CREATE TABLE file_folders (
 id TEXT PRIMARY KEY,
 company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 parent_id TEXT REFERENCES file_folders(id) ON DELETE RESTRICT,
 namespace_key TEXT NOT NULL,
 name TEXT NOT NULL,
 name_key TEXT NOT NULL,
 relative_path TEXT NOT NULL,
 path_key TEXT NOT NULL,
 duck_id TEXT REFERENCES ducks(id) ON DELETE SET NULL,
 computer_id TEXT REFERENCES computers(id) ON DELETE RESTRICT,
 source_box_id TEXT,
 source_token TEXT,
 physical INTEGER NOT NULL DEFAULT 0 CHECK(physical IN (0,1)),
 created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 created TEXT NOT NULL,
 updated TEXT NOT NULL,
 CHECK(relative_path<>'' AND relative_path NOT LIKE '/%' AND relative_path NOT LIKE '%/../%' AND relative_path NOT LIKE '../%'),
 CHECK((physical=0 AND computer_id IS NULL AND source_box_id IS NULL) OR
       (physical=1 AND computer_id IS NOT NULL AND source_box_id IS NOT NULL AND duck_id IS NOT NULL))
);
CREATE UNIQUE INDEX file_folders_sibling_name
 ON file_folders(company_id,namespace_key,COALESCE(parent_id,''),name_key);
CREATE UNIQUE INDEX file_folders_physical_path
 ON file_folders(company_id,computer_id,source_box_id,path_key) WHERE physical=1;
CREATE INDEX file_folders_company ON file_folders(company_id,namespace_key,parent_id);

CREATE TABLE file_folder_scopes (
 folder_id TEXT NOT NULL REFERENCES file_folders(id) ON DELETE CASCADE,
 scope_kind TEXT NOT NULL CHECK(scope_kind IN ('company','conversation','task')),
 scope_id TEXT NOT NULL,
 created TEXT NOT NULL,
 PRIMARY KEY(folder_id,scope_kind,scope_id)
);
CREATE INDEX file_folder_scopes_lookup ON file_folder_scopes(scope_kind,scope_id,folder_id);

CREATE TABLE file_folder_items (
 company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 folder_id TEXT NOT NULL REFERENCES file_folders(id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('document','upload','shared_file')),
 item_id TEXT NOT NULL,
 created TEXT NOT NULL,
 PRIMARY KEY(company_id,kind,item_id)
);
CREATE INDEX file_folder_items_folder ON file_folder_items(folder_id,kind,item_id);
