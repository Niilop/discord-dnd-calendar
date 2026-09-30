import type { CampaignMember, MemberRole } from "../../domain/types.js";
import type { Queryable } from "../db.js";

interface MemberRow {
  campaign_id: number;
  discord_user_id: string;
  role: MemberRole;
}

const toMember = (r: MemberRow): CampaignMember => ({ campaignId: r.campaign_id, userId: r.discord_user_id, role: r.role });

export async function findMemberRole(db: Queryable, campaignId: number, userId: string): Promise<MemberRole | null> {
  const [row] = await db.query<{ role: MemberRole }>(
    "SELECT role FROM campaign_member WHERE campaign_id = $1 AND discord_user_id = $2",
    [campaignId, userId],
  );
  return row?.role ?? null;
}

export async function listMembers(db: Queryable, campaignId: number): Promise<CampaignMember[]> {
  const rows = await db.query<MemberRow>(
    "SELECT * FROM campaign_member WHERE campaign_id = $1 ORDER BY role, created_at",
    [campaignId],
  );
  return rows.map(toMember);
}

export async function upsertMember(db: Queryable, campaignId: number, userId: string, role: MemberRole): Promise<void> {
  await db.query(
    `INSERT INTO campaign_member (campaign_id, discord_user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (campaign_id, discord_user_id) DO UPDATE SET role = EXCLUDED.role`,
    [campaignId, userId, role],
  );
}

export async function deleteMember(db: Queryable, campaignId: number, userId: string): Promise<boolean> {
  const rows = await db.query(
    "DELETE FROM campaign_member WHERE campaign_id = $1 AND discord_user_id = $2 RETURNING 1",
    [campaignId, userId],
  );
  return rows.length > 0;
}

/** Campaign ids in a guild where the user is a member, with their role. */
export async function listMembershipsInGuild(
  db: Queryable,
  guildId: string,
  userId: string,
): Promise<Map<number, MemberRole>> {
  const rows = await db.query<{ campaign_id: number; role: MemberRole }>(
    `SELECT m.campaign_id, m.role FROM campaign_member m JOIN campaign c ON c.id = m.campaign_id
     WHERE c.guild_id = $1 AND m.discord_user_id = $2`,
    [guildId, userId],
  );
  return new Map(rows.map((r) => [r.campaign_id, r.role]));
}

/** Distinct members of any campaign in the guild — the people the server calendar counts. */
export async function listGuildMemberIds(db: Queryable, guildId: string): Promise<string[]> {
  const rows = await db.query<{ discord_user_id: string }>(
    `SELECT DISTINCT m.discord_user_id FROM campaign_member m JOIN campaign c ON c.id = m.campaign_id
     WHERE c.guild_id = $1 ORDER BY m.discord_user_id`,
    [guildId],
  );
  return rows.map((r) => r.discord_user_id);
}
