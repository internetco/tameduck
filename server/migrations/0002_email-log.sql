-- The email log: every email the server tries to send.
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- One row per attempt, with what happened: sent, failed (error says why), or
-- off (the person has that kind switched off). server/email-log.mjs writes it.
--
-- user_id is the person whenever there is one. No foreign keys: the log
-- outlives the person and the company it was about.
CREATE TABLE email_log(
  id TEXT PRIMARY KEY,
  created TEXT NOT NULL,
  user_id TEXT,
  company_id TEXT,
  kind TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '');
CREATE INDEX email_log_user ON email_log(user_id, created);
CREATE INDEX email_log_company ON email_log(company_id, created);
CREATE INDEX email_log_created ON email_log(created);

-- An invitation, and the first sign-in link, go to an address with no account
-- yet. When the account is made, those rows become the person's, so "every
-- email we sent Sam" includes the two that matter most when somebody says they
-- never got their invitation.
CREATE TRIGGER email_log_claim AFTER INSERT ON users BEGIN
  UPDATE email_log SET user_id=NEW.id
   WHERE user_id IS NULL AND lower(to_address)=lower(NEW.email);
END;
