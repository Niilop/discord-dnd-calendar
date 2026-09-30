import type { Campaign } from "../../domain/types.js";
import type { Queryable } from "../db.js";

interface CampaignRow {
  id: number;
  guild_id: string;
  name: string;
  timezone: string;
  rsvp_channel_id: string | null;
  current_session: number;
  reminder_minutes: number | null;
  reminder_pings: boolean;
  color: string;
  created_at: Date;
  updated_at: Date;
}

const toCampaign = (r: CampaignRow): Campaign => ({
  id: r.id,
  guildId: r.guild_id,
  name: r.name,
  timezone: r.timezone,
  rsvpChannelId: r.rsvp_channel_id,
  currentSession: r.current_session,
  reminderMinutes: r.reminder_minutes,
  reminderPings: r.reminder_pings,
  color: r.color,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Campaigns read their timezone from the server settings. */
const SELECT = `
  SELECT c.id, c.guild_id, c.name, g.timezone, c.rsvp_channel_id, c.current_session,
         c.reminder_minutes, c.reminder_pings, c.color, c.created_at, c.updated_at
  FROM campaign c JOIN guild_settings g ON g.guild_id = c.guild_id`;

export interface NewCampaign {
  guildId: string;
  name: string;
  rsvpChannelId: string | null;
  currentSession: number;
  color: string;
}

export type CampaignPatch = Partial<
  Pick<
    Campaign,
    "name" | "rsvpChannelId" | "currentSession" | "reminderMinutes" | "reminderPings" | "color"
  >
>;

const PATCH_COLUMNS: Record<keyof CampaignPatch, string> = {
  name: "name",
  rsvpChannelId: "rsvp_channel_id",
  currentSession: "current_session",
  reminderMinutes: "reminder_minutes",
  reminderPings: "reminder_pings",
  color: "color",
};

export async function insertCampaign(db: Queryable, c: NewCampaign): Promise<Campaign> {
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO campaign (guild_id, name, rsvp_channel_id, current_session, color)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [c.guildId, c.name, c.rsvpChannelId, c.currentSession, c.color],
  );
  return (await findCampaign(db, row!.id))!;
}

export async function updateCampaign(db: Queryable, id: number, patch: CampaignPatch): Promise<Campaign | null> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof CampaignPatch, unknown][];
  const sets = entries.map(([key], i) => `${PATCH_COLUMNS[key]} = $${i + 2}`);
  const rows = await db.query(
    `UPDATE campaign SET ${[...sets, "updated_at = now()"].join(", ")} WHERE id = $1 RETURNING id`,
    [id, ...entries.map(([, v]) => v)],
  );
  return rows.length ? findCampaign(db, id) : null;
}

export async function deleteCampaign(db: Queryable, id: number): Promise<void> {
  await db.query("DELETE FROM campaign WHERE id = $1", [id]);
}

export async function findCampaign(db: Queryable, id: number, opts: { forUpdate?: boolean } = {}): Promise<Campaign | null> {
  const [row] = await db.query<CampaignRow>(`${SELECT} WHERE c.id = $1${opts.forUpdate ? " FOR UPDATE OF c" : ""}`, [id]);
  return row ? toCampaign(row) : null;
}

export async function listCampaignsByGuild(db: Queryable, guildId: string): Promise<Campaign[]> {
  const rows = await db.query<CampaignRow>(`${SELECT} WHERE c.guild_id = $1 ORDER BY lower(c.name)`, [guildId]);
  return rows.map(toCampaign);
}

export async function campaignNameExists(db: Queryable, guildId: string, name: string, exceptId?: number): Promise<boolean> {
  const rows = await db.query(
    "SELECT 1 FROM campaign WHERE guild_id = $1 AND lower(name) = lower($2) AND id <> $3",
    [guildId, name, exceptId ?? -1],
  );
  return rows.length > 0;
}
