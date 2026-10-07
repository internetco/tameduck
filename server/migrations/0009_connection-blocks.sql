-- connection-blocks
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- A duck that stopped at a connection: it is not allowed to use it ('access'),
-- or the connection would not let TameDuck in and somebody has to sign in again
-- ('sign_in'). All it left before was a sentence - "Please enable the Site.eu
-- connection for Publishing Duck" - with nothing on it to press. The server
-- knows the cause at the moment it refuses, so it writes it down here, and the
-- person gets one button, Allow or Reconnect.
--
-- One row per place a duck is waiting: a chat, a thread in it, or a ticket.
-- The same duck stopped in two people's chats is two places, and both carry
-- on once it is fixed; Needs you shows them as one line.
CREATE TABLE connection_blocks(
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  duck_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('access','sign_in')),
  place TEXT NOT NULL,
  job_id TEXT NOT NULL,
  user_id TEXT,
  conversation_id TEXT,
  thread_id TEXT,
  task_id TEXT,
  message_id TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','fixed','dismissed')),
  settled_by TEXT,
  -- Fixed while the duck's run was still going: the line to carry it on with
  -- once that run has ended, so the new run does not start under the old one.
  carry_on TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE UNIQUE INDEX connection_blocks_waiting
  ON connection_blocks(connection_id,duck_id,kind,place) WHERE status='waiting';
CREATE INDEX connection_blocks_company ON connection_blocks(company_id,status);
