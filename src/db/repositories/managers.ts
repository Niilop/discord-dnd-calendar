import type { Queryable } from "../db.js";

export interface ManagerRow {
  guildId: string;
  userId: string;
}

export async function listAllManagers(db: Queryable): Promise<ManagerRow[]> {
  return db.query<ManagerRow>(`SELECT guild_id AS "guildId", discord_user_id AS "userId" FROM calendar_manager`);
}

export async function listManagers(db: Queryable, guildId: string): Promise<string[]> {
  const rows = await db.query<{ user_id: string }>(
    "SELECT discord_user_id AS user_id FROM calendar_manager WHERE guild_id = $1 ORDER BY created_at",
    [guildId],
  );
  return rows.map((r) => r.user_id);
}

/** Returns false if they already were a manager. */
export async function insertManager(db: Queryable, guildId: string, userId: string, addedBy: string): Promise<boolean> {
  const rows = await db.query(
    "INSERT INTO calendar_manager (guild_id, discord_user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1",
    [guildId, userId, addedBy],
  );
  return rows.length > 0;
}

/** Returns false if they weren't a manager. */
export async function deleteManager(db: Queryable, guildId: string, userId: string): Promise<boolean> {
  const rows = await db.query("DELETE FROM calendar_manager WHERE guild_id = $1 AND discord_user_id = $2 RETURNING 1", [
    guildId,
    userId,
  ]);
  return rows.length > 0;
}
