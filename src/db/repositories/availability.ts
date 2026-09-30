import type { AvailabilityEntry, AvailabilityStatus, LocalDate } from "../../domain/types.js";
import type { Queryable } from "../db.js";

interface AvailabilityRow {
  guild_id: string;
  discord_user_id: string;
  date: string;
  status: AvailabilityStatus;
}

const toEntry = (r: AvailabilityRow): AvailabilityEntry => ({
  guildId: r.guild_id,
  userId: r.discord_user_id,
  date: r.date,
  status: r.status,
});

export async function listAvailability(
  db: Queryable,
  guildId: string,
  from: LocalDate,
  to: LocalDate,
  userId?: string,
): Promise<AvailabilityEntry[]> {
  const rows = await db.query<AvailabilityRow>(
    `SELECT guild_id, discord_user_id, to_char(date, 'YYYY-MM-DD') AS date, status
     FROM availability
     WHERE guild_id = $1 AND date BETWEEN $2 AND $3 AND ($4::text IS NULL OR discord_user_id = $4)
     ORDER BY date, discord_user_id`,
    [guildId, from, to, userId ?? null],
  );
  return rows.map(toEntry);
}

export async function upsertAvailability(
  db: Queryable,
  guildId: string,
  userId: string,
  dates: readonly LocalDate[],
  status: AvailabilityStatus,
): Promise<void> {
  if (!dates.length) return;
  await db.query(
    `INSERT INTO availability (guild_id, discord_user_id, date, status)
     SELECT $1, $2, d, $4 FROM unnest($3::date[]) AS d
     ON CONFLICT (guild_id, discord_user_id, date) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
    [guildId, userId, dates, status],
  );
}

export async function deleteAvailability(
  db: Queryable,
  guildId: string,
  userId: string,
  dates: readonly LocalDate[],
): Promise<void> {
  if (!dates.length) return;
  await db.query(
    "DELETE FROM availability WHERE guild_id = $1 AND discord_user_id = $2 AND date = ANY($3::date[])",
    [guildId, userId, dates],
  );
}
