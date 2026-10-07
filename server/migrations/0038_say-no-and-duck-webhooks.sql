-- Saying no to a duck's screen request, and a duck's own webhook.
--
-- A person asked for their screen can now refuse it, with an optional reason
-- the duck reads when it carries on. The request is finished as 'completed'
-- like a hand-back, so the waiting run resumes; these two columns are what
-- tell the card, and the duck, that the answer was no.
ALTER TABLE human_requests ADD COLUMN declined_at TEXT;
ALTER TABLE human_requests ADD COLUMN declined_reason TEXT;

-- One webhook per duck, off until somebody who may change ducks turns it on.
-- server/duck-webhooks.mjs owns both tables. Nothing secret is kept readable:
-- the link and the API key are stored as SHA-256 hashes and shown once; the
-- signing secret for answers sent back has to be used again, so it is
-- encrypted with the vault key like every other secret.
CREATE TABLE duck_webhooks (
 duck_id TEXT PRIMARY KEY REFERENCES ducks(id),
 company_id TEXT NOT NULL REFERENCES companies(id),
 enabled INTEGER NOT NULL DEFAULT 0,
 link_hash TEXT UNIQUE,
 link_hint TEXT,
 -- Whose name the work runs under: whoever last turned it on.
 runner_id TEXT REFERENCES users(id),
 instructions TEXT NOT NULL DEFAULT '',
 hourly_limit INTEGER NOT NULL DEFAULT 20,
 -- Optional extra locks. Empty means not set.
 allowed_ips TEXT NOT NULL DEFAULT '',
 key_hash TEXT,
 key_hint TEXT,
 -- Optional: where answers are sent back, and the secret they are signed with.
 reply_url TEXT NOT NULL DEFAULT '',
 signing_secret TEXT,
 enabled_at TEXT,
 updated_by TEXT REFERENCES users(id),
 created TEXT NOT NULL,
 updated TEXT NOT NULL
);

-- Every call that reached a known link, started or refused, and what became
-- of the answer sent back. Calls to a link nobody has are not recorded: there
-- is no duck to file them under.
CREATE TABLE duck_webhook_deliveries (
 id TEXT PRIMARY KEY,
 company_id TEXT NOT NULL REFERENCES companies(id),
 duck_id TEXT NOT NULL REFERENCES ducks(id),
 received TEXT NOT NULL,
 ip TEXT NOT NULL DEFAULT '',
 source TEXT NOT NULL DEFAULT '',
 summary TEXT NOT NULL DEFAULT '',
 outcome TEXT NOT NULL CHECK(outcome IN ('started','refused')),
 reason TEXT NOT NULL DEFAULT '',
 test INTEGER NOT NULL DEFAULT 0,
 message_id TEXT REFERENCES messages(id),
 job_id TEXT REFERENCES jobs(id),
 reply_url TEXT NOT NULL DEFAULT '',
 reply_state TEXT NOT NULL DEFAULT 'none' CHECK(reply_state IN ('none','pending','sent','failed')),
 reply_attempts INTEGER NOT NULL DEFAULT 0,
 reply_next_at INTEGER,
 reply_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX duck_webhook_deliveries_duck ON duck_webhook_deliveries(duck_id, received);
CREATE INDEX duck_webhook_deliveries_message ON duck_webhook_deliveries(message_id);
CREATE INDEX duck_webhook_deliveries_reply ON duck_webhook_deliveries(reply_state, reply_next_at);
