-- Initial schema for the D&D scheduling bot.
--
-- Conventions:
--   * Discord snowflakes are stored as text (they exceed JS safe integers).
--   * Instants are timestamptz (UTC internally); availability dates are plain
--     DATE values interpreted in the campaign's timezone.
--   * Enumerations use text + CHECK so new values (e.g. a 'scheduler' role)
--     are a one-line migration.
--   * "No row" means unspecified availability / no RSVP response.

CREATE TABLE campaign (
    id                                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    guild_id                          text        NOT NULL,
    name                              text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    timezone                          text        NOT NULL,
    calendar_channel_id               text        NOT NULL,
    rsvp_channel_id                   text        NOT NULL,
    default_session_duration_minutes  integer     CHECK (default_session_duration_minutes BETWEEN 15 AND 1440),
    -- Minutes before session start at which reminders are sent. Default: 48h.
    reminder_offsets_minutes          integer[]   NOT NULL DEFAULT '{2880}',
    -- The single persistent calendar message for this campaign.
    calendar_message_channel_id       text,
    calendar_message_id               text,
    calendar_message_month            text,
    created_at                        timestamptz NOT NULL DEFAULT now(),
    updated_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX campaign_guild_name_key ON campaign (guild_id, lower(name));

CREATE TABLE campaign_member (
    campaign_id      integer     NOT NULL REFERENCES campaign (id) ON DELETE CASCADE,
    discord_user_id  text        NOT NULL,
    role             text        NOT NULL CHECK (role IN ('admin', 'player')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, discord_user_id)
);

CREATE INDEX campaign_member_user_idx ON campaign_member (discord_user_id);

CREATE TABLE availability (
    campaign_id      integer     NOT NULL,
    discord_user_id  text        NOT NULL,
    date             date        NOT NULL,
    status           text        NOT NULL CHECK (status IN ('unavailable', 'prefer_not')),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, discord_user_id, date),
    -- Removing a member (or the campaign) removes their availability.
    FOREIGN KEY (campaign_id, discord_user_id)
        REFERENCES campaign_member (campaign_id, discord_user_id) ON DELETE CASCADE
);

CREATE INDEX availability_campaign_date_idx ON availability (campaign_id, date);

CREATE TABLE session (
    id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    campaign_id          integer     NOT NULL REFERENCES campaign (id) ON DELETE CASCADE,
    title                text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
    starts_at            timestamptz NOT NULL,
    ends_at              timestamptz NOT NULL,
    notes                text        CHECK (char_length(notes) <= 1000),
    created_by           text        NOT NULL,
    status               text        NOT NULL DEFAULT 'scheduled'
                                     CHECK (status IN ('scheduled', 'cancelled', 'completed')),
    -- When the start time was last set; reminders whose due time is before
    -- this are skipped (the RSVP card announcement already notified people).
    schedule_changed_at  timestamptz NOT NULL DEFAULT now(),
    discord_channel_id   text,
    discord_message_id   text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);

CREATE INDEX session_campaign_starts_idx ON session (campaign_id, starts_at);
CREATE INDEX session_scheduled_starts_idx ON session (starts_at) WHERE status = 'scheduled';

CREATE TABLE session_rsvp (
    session_id       integer     NOT NULL REFERENCES session (id) ON DELETE CASCADE,
    discord_user_id  text        NOT NULL,
    status           text        NOT NULL CHECK (status IN ('attending', 'maybe', 'absent')),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, discord_user_id)
);

-- Idempotency log for anything the scheduler sends about a session
-- (e.g. 'reminder:2880'). Future behaviours such as 'all_responded' or
-- 'low_attendance' use the same table with a new kind.
CREATE TABLE session_notification (
    session_id  integer     NOT NULL REFERENCES session (id) ON DELETE CASCADE,
    kind        text        NOT NULL,
    sent_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, kind)
);
