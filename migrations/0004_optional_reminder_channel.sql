-- The reminder channel is optional (no reminders/notices without it), and the
-- usual start time comes from the campaign's most recent session instead of a setting.
ALTER TABLE campaign
    ALTER COLUMN rsvp_channel_id DROP NOT NULL,
    DROP COLUMN default_start_time;
