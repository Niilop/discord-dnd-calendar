-- Session numbers and no session length.
--
-- * campaign.current_session is the last played session's number. Upcoming
--   sessions are numbered current_session + 1, + 2, … in date order, so they
--   renumber themselves when one is moved, cancelled or the setting changes.
--   A session keeps the number it had when it was completed or cancelled
--   (session.number); completing one raises current_session by one.
-- * session.title becomes an optional subtitle ("Session 14: Into the Castle").
-- * Sessions have no length any more: a session lasts until the end of its
--   local day, which is when RSVPs close and it counts as played.

ALTER TABLE campaign
    ADD COLUMN current_session integer NOT NULL DEFAULT 0 CHECK (current_session >= 0);

ALTER TABLE session
    ADD COLUMN number integer,
    ALTER COLUMN title DROP NOT NULL;

-- Generated "Session N" titles are replaced by the automatic number.
UPDATE session SET title = NULL WHERE title ~ '^Session [0-9]+$';

WITH played AS (
    SELECT id, row_number() OVER (PARTITION BY campaign_id ORDER BY starts_at, id) AS n
    FROM session WHERE status = 'completed'
)
UPDATE session s SET number = played.n FROM played WHERE s.id = played.id;

UPDATE campaign c
SET current_session = (SELECT count(*) FROM session s WHERE s.campaign_id = c.id AND s.status = 'completed');

-- Upcoming sessions now end at midnight (existing timezones are all IANA names).
UPDATE session s
SET ends_at = (date_trunc('day', s.starts_at AT TIME ZONE g.timezone) + interval '1 day') AT TIME ZONE g.timezone
FROM campaign c JOIN guild_settings g ON g.guild_id = c.guild_id
WHERE s.campaign_id = c.id AND s.status = 'scheduled';

-- Every session read goes through this view to get its number.
CREATE VIEW session_numbered AS
SELECT s.*,
       (CASE WHEN s.status = 'scheduled'
             THEN c.current_session + row_number() OVER (PARTITION BY s.campaign_id, s.status ORDER BY s.starts_at, s.id)
             ELSE s.number END)::integer AS display_number
FROM session s JOIN campaign c ON c.id = s.campaign_id;

-- default_session_duration_minutes is no longer read; it stays one release for rollback.
