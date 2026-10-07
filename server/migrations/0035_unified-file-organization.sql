CREATE TABLE file_folder_items_next (
 company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 folder_id TEXT NOT NULL REFERENCES file_folders(id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('document','upload','shared_file','screenshot','notes')),
 item_id TEXT NOT NULL,
 created TEXT NOT NULL,
 PRIMARY KEY(company_id,kind,item_id)
);
INSERT INTO file_folder_items_next SELECT * FROM file_folder_items;
DROP TABLE file_folder_items;
ALTER TABLE file_folder_items_next RENAME TO file_folder_items;
CREATE INDEX file_folder_items_folder ON file_folder_items(folder_id,kind,item_id);
CREATE TABLE file_folder_materializations (
 folder_id TEXT NOT NULL REFERENCES file_folders(id) ON DELETE CASCADE,
 computer_id TEXT NOT NULL,
 source_box_id TEXT NOT NULL,
 created TEXT NOT NULL,
 PRIMARY KEY(folder_id,computer_id,source_box_id)
);
