-- Each campaign has a color used for its sessions on the calendar image,
-- the calendar panel accent and RSVP cards.
ALTER TABLE campaign
    ADD COLUMN color text NOT NULL DEFAULT '#3e63dd' CHECK (color ~ '^#[0-9a-f]{6}$');

-- Layout version of the persistent calendar message. When the layout changes
-- in a way Discord can't edit in place (e.g. classic embed → components v2),
-- the bot posts a fresh message and deletes the old one.
ALTER TABLE campaign
    ADD COLUMN calendar_message_layout smallint NOT NULL DEFAULT 1;
