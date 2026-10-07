-- invite-links-kept
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- Copy link on Team > Waiting to join. An invitation's link was kept only as
-- a hash, so once the dialog that made it closed nobody could see it again,
-- and Revoke was the only thing left to press. token_enc is the token
-- encrypted with ENCRYPTION_KEY, the way secrets are kept. A link is still
-- checked against token_hash only. It is emptied when the invitation is taken
-- or replaced. Invitations made before this have none; Send again gives them
-- one.
ALTER TABLE invites ADD COLUMN token_enc TEXT;

-- When it was sent, for "Invited by you on Sep 23". Every invitation so far
-- was made to last seven days, so that is when the old ones were sent.
ALTER TABLE invites ADD COLUMN created INTEGER NOT NULL DEFAULT 0;
UPDATE invites SET created = expires - 604800000;
