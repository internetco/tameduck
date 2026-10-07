-- activity-who-and-kind
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- The activity log could not say which duck did a thing, or in which run. A
-- duck reading a secret was written down with nobody at all, and a duck's run
-- under the person who asked for it, so the log named the wrong one. It also
-- had no way to show one kind of row without reading them all, and no index,
-- so it could only ever send the newest hundred.
--
-- duck_id  the duck the row is about, or that did it
-- job_id   the run it happened in
-- kind     which of the log's filters it belongs to: secrets (secrets and
--          connections), tools (tool decisions), work (what ducks did) or
--          people (what people did, and settings). audit() in
--          server/store.mjs sets it from the action, with kindOf() in
--          server/activity-words.mjs; tests/activity-words.test.mjs checks the
--          two lists below still say the same thing as that one.
ALTER TABLE audit ADD COLUMN duck_id TEXT;
ALTER TABLE audit ADD COLUMN job_id TEXT;
ALTER TABLE audit ADD COLUMN kind TEXT;

-- Rows already written get their kind from their action, the same way.
UPDATE audit SET kind = CASE
  WHEN action IN (
    'Secret group created', 'Secret group renamed', 'Secret group removed',
    'Secrets saved', 'Secrets moved', 'Secret saved', 'Secret updated',
    'Secret deleted', 'Duck replaced a secret', 'Duck saved a secret',
    'Duck read a secret', 'Duck used a secret', 'MCP connection added',
    'MCP connection created', 'MCP connection updated', 'MCP connection removed',
    'MCP connection disconnected', 'MCP sign-in started', 'MCP account connected',
    'AI provider connected', 'AI provider disconnected',
    'Duck allowed to use a connection'
  ) THEN 'secrets'
  WHEN action LIKE 'Tool approval %' OR action = 'Connected tool executed'
    THEN 'tools'
  WHEN action IN (
    'Duck finished a run', 'Duck run needs attention', 'Duck used computer',
    'Duck used computer terminal', 'Duck saved document', 'Duck updated notes',
    'Chief recruited a duck', 'Chief updated a ticket', 'Duck updated task',
    'Chief delegated a task', 'Duck used default model fallback',
    'Chief changed a board with standing permission', 'Duck withdrew a request',
    'Computer resumed', 'Computer created', 'Idle computer saving and stopping',
    'Computer saving and stopping', 'Screen given back after nobody came back'
  ) OR action LIKE 'Chief proposed board %' OR action LIKE 'Chief proposed skill %'
    THEN 'work'
  ELSE 'people'
END;

-- The log reads a company's rows a day at a time, newest first, with or
-- without one kind; and its tool decisions from approvals by when they ended.
CREATE INDEX audit_company_created ON audit(company_id, created);
CREATE INDEX audit_company_kind_created ON audit(company_id, kind, created);
CREATE INDEX approvals_company_updated ON approvals(company_id, updated);
