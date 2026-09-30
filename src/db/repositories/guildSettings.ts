import type { GuildSettings, YearMonth } from "../../domain/types.js";
import type { Queryable } from "../db.js";

interface GuildSettingsRow {
  guild_id: string;
  timezone: string;
  calendar_channel_id: string;
  calendar_message_channel_id: string | null;
  calendar_message_id: string | null;
  calendar_message_month: string | null;
  calendar_message_layout: number;
}

const toSettings = (r: GuildSettingsRow): GuildSettings => ({
  guildId: r.guild_id,
  timezone: r.timezone,
  calendarChannelId: r.calendar_channel_id,
  calendarMessageChannelId: r.calendar_message_channel_id,
  calendarMessageId: r.calendar_message_id,
  calendarMessageMonth: r.calendar_message_month,
  calendarMessageLayout: r.calendar_message_layout,
});

export async function findGuildSettings(db: Queryable, guildId: string): Promise<GuildSettings | null> {
  const [row] = await db.query<GuildSettingsRow>("SELECT * FROM guild_settings WHERE guild_id = $1", [guildId]);
  return row ? toSettings(row) : null;
}

export async function listGuildSettings(db: Queryable): Promise<GuildSettings[]> {
  const rows = await db.query<GuildSettingsRow>("SELECT * FROM guild_settings ORDER BY guild_id");
  return rows.map(toSettings);
}

export async function upsertGuildSettings(
  db: Queryable,
  guildId: string,
  settings: { timezone: string; calendarChannelId: string },
): Promise<GuildSettings> {
  const [row] = await db.query<GuildSettingsRow>(
    `INSERT INTO guild_settings (guild_id, timezone, calendar_channel_id) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id) DO UPDATE SET timezone = EXCLUDED.timezone,
       calendar_channel_id = EXCLUDED.calendar_channel_id, updated_at = now()
     RETURNING *`,
    [guildId, settings.timezone, settings.calendarChannelId],
  );
  return toSettings(row!);
}

export async function setGuildCalendarMessage(
  db: Queryable,
  guildId: string,
  message: { channelId: string; messageId: string; month: YearMonth; layout: number },
): Promise<void> {
  await db.query(
    `UPDATE guild_settings SET calendar_message_channel_id = $2, calendar_message_id = $3,
       calendar_message_month = $4, calendar_message_layout = $5
     WHERE guild_id = $1`,
    [guildId, message.channelId, message.messageId, message.month, message.layout],
  );
}
