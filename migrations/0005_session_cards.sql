-- Session cards: each session has at most one message in its campaign's
-- reminder channel. It is posted when the reminder window opens (or right
-- away for a session created inside it), edited in place afterwards, and
-- deleted when the session's day ends. Reschedules and cancellations change
-- that card instead of posting separate notices.

-- One reminder time instead of a list; NULL means no automatic card.
ALTER TABLE campaign
    ADD COLUMN reminder_minutes integer DEFAULT 2880 CHECK (reminder_minutes BETWEEN 30 AND 20160),
    -- Whether posting or changing a card pings players. Off by default.
    ADD COLUMN reminder_pings   boolean NOT NULL DEFAULT false;

UPDATE campaign SET reminder_minutes = (SELECT max(m) FROM unnest(reminder_offsets_minutes) AS m);

-- reminder_offsets_minutes is no longer read, but stays until the next
-- release so a rollback to the previous image still works (expand, then contract).

ALTER TABLE session
    -- The start time the posted card (discord_message_id) was made for. When
    -- the session moves away, the card turns into a "moved" note that expires
    -- at the end of this day.
    ADD COLUMN card_starts_at     timestamptz,
    -- The start time before the last reschedule, shown as "Moved from …".
    ADD COLUMN previous_starts_at timestamptz,
    ADD COLUMN cancel_reason      text CHECK (char_length(cancel_reason) <= 500);

-- 'reminder:%' rows are no longer used: whether a session has a card is its idempotency.
DELETE FROM session_notification WHERE kind LIKE 'reminder:%';
