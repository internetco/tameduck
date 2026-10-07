-- A browser opt-in belongs to the exact signed-in session and workspace.
-- The endpoint is a bearer capability and must stay in the protected database.
CREATE TABLE web_push_subscriptions (
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created TEXT NOT NULL,
  PRIMARY KEY(endpoint,company_id)
);
CREATE INDEX web_push_subscriptions_session ON web_push_subscriptions(session_hash);
CREATE TABLE web_push_deliveries (
  endpoint TEXT NOT NULL,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_id TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY(endpoint,company_id,kind,event_id),
  FOREIGN KEY(endpoint,company_id) REFERENCES web_push_subscriptions(endpoint,company_id) ON DELETE CASCADE
);
CREATE INDEX web_push_deliveries_age ON web_push_deliveries(delivered_at);
-- Revocation must persist even if a person is re-added before the next poll.
CREATE TRIGGER web_push_membership_revoked AFTER DELETE ON memberships
BEGIN
  DELETE FROM web_push_subscriptions WHERE company_id=OLD.company_id AND user_id=OLD.user_id;
END;
