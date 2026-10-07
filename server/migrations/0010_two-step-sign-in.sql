-- two-step-sign-in
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- Two-step sign-in: after the email link or the password, a code from an
-- authenticator app. server/two-step.mjs reads and writes all three tables.
--
-- One row per person who has started turning it on. secret is the app's key,
-- encrypted like every other secret here. confirmed stays 0 until the person
-- has typed one good code, so a key that never reached their phone never
-- locks them out. last_step is the newest 30-second step a code was accepted
-- for: a code is only taken for a later step, so one seen over a shoulder
-- cannot be used again. wrong and wrong_since count wrong codes in the
-- current quarter of an hour, across every sign-in, so starting over does not
-- buy more guesses.
CREATE TABLE two_step(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  last_step INTEGER NOT NULL DEFAULT 0,
  wrong INTEGER NOT NULL DEFAULT 0,
  wrong_since INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL);

-- The backup codes, for a lost phone. Only a keyed hash is kept, and each one
-- is spent by setting used, once.
CREATE TABLE two_step_backup_codes(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, code_hash));

-- A sign-in that got past the first step and is waiting for the code. It is
-- not a session and opens nothing: the browser holds it in an HttpOnly cookie
-- for five minutes, and it becomes a session only after a right code.
-- company_id is empty for somebody who is in no company yet: which one they
-- join, or whether new_company is started for them, is only decided after the
-- code, so the first step alone changes nothing.
CREATE TABLE pending_sign_ins(
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
  new_company TEXT,
  expires INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0);
CREATE INDEX pending_sign_ins_user ON pending_sign_ins(user_id);
