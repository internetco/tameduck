-- ticket-work-has-a-person
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- Duck work on a ticket runs in the ticket's own conversation (kind 'ticket'),
-- so it stays out of everybody's direct messages. Those conversations were made
-- with nobody in them, on the reasoning that no chat sidebar would then list
-- them. But every part of the product that decides who can act on a duck's work
-- decides it by membership of the conversation the work ran in: who sees a
-- duck's request for a sign-in code, who may answer it or take the screen, who
-- gets its question under Needs you, who is reminded, who sees the run to stop
-- it. With nobody in the room, a duck on a ticket asking for a code was asking
-- no one, and its screen stayed locked until the wait ran out.
--
-- The person a job runs for now belongs to that job's ticket conversation.
-- Sidebars still do not list it: they show direct, human and group
-- conversations only, so a 'ticket' one appears in none of them.
CREATE TRIGGER ticket_job_member AFTER INSERT ON jobs
WHEN (SELECT kind FROM conversations WHERE id=NEW.conversation_id)='ticket'
BEGIN
 INSERT OR IGNORE INTO conversation_members(conversation_id,user_id)
 VALUES(NEW.conversation_id,NEW.user_id);
END;

-- Ticket conversations made before this, and the people their work ran for.
INSERT OR IGNORE INTO conversation_members(conversation_id,user_id)
 SELECT DISTINCT j.conversation_id,j.user_id FROM jobs j
 JOIN conversations c ON c.id=j.conversation_id
 WHERE c.kind='ticket' AND j.user_id IS NOT NULL;
