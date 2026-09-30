-- Calendar managers: people a server's admins (or other managers, or a bot
-- admin from BOT_ADMIN_USER_IDS) have given full calendar rights on that
-- server, without needing Manage Server in Discord.
CREATE TABLE calendar_manager (
    guild_id         text        NOT NULL,
    discord_user_id  text        NOT NULL,
    added_by         text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, discord_user_id)
);
