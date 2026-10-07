ALTER TABLE secrets ADD COLUMN created_by_user TEXT REFERENCES users(id);
