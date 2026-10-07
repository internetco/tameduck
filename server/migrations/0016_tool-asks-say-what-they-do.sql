-- tool-asks-say-what-they-do
--
-- Runs once, in a transaction, with foreign keys off and checked afterwards.
-- Once this has run anywhere, never edit it: write the next migration instead.

-- A duck asking to use a connected tool now says, in one plain line, what it
-- will send and where: "Add the checklist to the Finance page in Notion". It
-- is the title of the card a person decides on. All there was before was the
-- tool's own name, so the card read "Api post page on Notion". Empty for the
-- asks made before this, which keep that.
ALTER TABLE approvals ADD COLUMN summary TEXT;
