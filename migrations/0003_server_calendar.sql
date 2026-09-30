-- One calendar per server instead of one per campaign.
--   * guild_settings holds the server's timezone and calendar channel/message.
--   * Campaigns take their timezone from the server (joined at read time).
--   * Availability is per server: a player unavailable on a date is
--     unavailable for every campaign.

CREATE TABLE guild_settings (
    guild_id                     text PRIMARY KEY,
    timezone                     text        NOT NULL,
    calendar_channel_id          text        NOT NULL,
    calendar_message_channel_id  text,
    calendar_message_id          text,
    calendar_message_month       text,
    calendar_message_layout      smallint    NOT NULL DEFAULT 0,
    created_at                   timestamptz NOT NULL DEFAULT now(),
    updated_at                   timestamptz NOT NULL DEFAULT now()
);

-- Existing servers: take timezone and calendar channel from their oldest campaign.
INSERT INTO guild_settings (guild_id, timezone, calendar_channel_id)
SELECT DISTINCT ON (guild_id) guild_id, timezone, calendar_channel_id
FROM campaign
ORDER BY guild_id, id;

-- Per-server availability. Conflicting marks across campaigns merge; unavailable wins.
CREATE TABLE server_availability (
    guild_id         text        NOT NULL,
    discord_user_id  text        NOT NULL,
    date             date        NOT NULL,
    status           text        NOT NULL CHECK (status IN ('unavailable', 'prefer_not')),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, discord_user_id, date)
);

INSERT INTO server_availability (guild_id, discord_user_id, date, status, updated_at)
SELECT c.guild_id,
       a.discord_user_id,
       a.date,
       CASE WHEN bool_or(a.status = 'unavailable') THEN 'unavailable' ELSE 'prefer_not' END,
       max(a.updated_at)
FROM availability a
JOIN campaign c ON c.id = a.campaign_id
GROUP BY c.guild_id, a.discord_user_id, a.date;

DROP TABLE availability;
ALTER TABLE server_availability RENAME TO availability;
ALTER INDEX server_availability_pkey RENAME TO availability_pkey;
CREATE INDEX availability_guild_date_idx ON availability (guild_id, date);

ALTER TABLE campaign
    DROP COLUMN timezone,
    DROP COLUMN calendar_channel_id,
    DROP COLUMN calendar_message_channel_id,
    DROP COLUMN calendar_message_id,
    DROP COLUMN calendar_message_month,
    DROP COLUMN calendar_message_layout,
    -- Default start time (campaign-local wall clock) for new sessions.
    ADD COLUMN default_start_time time;
