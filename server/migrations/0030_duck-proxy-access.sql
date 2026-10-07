-- Absence means allowed. Existing and newly created ducks keep proxy access.
CREATE TABLE duck_proxy_access (
  duck_id TEXT NOT NULL REFERENCES ducks(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  PRIMARY KEY(duck_id,company_id)
);
CREATE INDEX duck_proxy_access_company ON duck_proxy_access(company_id);
