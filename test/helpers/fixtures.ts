import type { Db } from "../../src/db/db.js";
import { upsertMember } from "../../src/db/repositories/members.js";
import type { Actor } from "../../src/domain/permissions.js";
import type { Campaign, GuildSettings, MemberRole } from "../../src/domain/types.js";
import { createCampaign } from "../../src/services/campaignService.js";
import { setupServerCalendar } from "../../src/services/guildService.js";

export const GUILD = "100000000000000001";
export const OTHER_GUILD = "100000000000000002";
export const DM = "200000000000000001";
export const ALICE = "200000000000000002";
export const BOB = "200000000000000003";
export const CAROL = "200000000000000004";
export const SERVER_ADMIN = "200000000000000099";
export const OUTSIDER = "200000000000000098";

export function actor(userId: string, opts: { admin?: boolean; guildId?: string } = {}): Actor {
  return { userId, guildId: opts.guildId ?? GUILD, isGuildAdmin: opts.admin ?? false };
}

export const serverAdmin = actor(SERVER_ADMIN, { admin: true });

/** The server calendar: Europe/Helsinki, like `/calendar setup`. */
export async function seedServer(db: Db, timezone = "Europe/Helsinki"): Promise<GuildSettings> {
  return setupServerCalendar(db, serverAdmin, { timezone, calendarChannelId: "300000000000000001" });
}

/** A campaign with DM as admin and Alice, Bob as players (sets up the server if needed). */
export async function seedCampaign(db: Db, overrides: { name?: string; color?: string } = {}): Promise<Campaign> {
  await seedServer(db);
  const campaign = await createCampaign(db, serverAdmin, {
    name: overrides.name ?? "Curse of Strahd",
    rsvpChannelId: "300000000000000002",
    dmUserId: DM,
    color: overrides.color ?? "red",
  });
  await addRaw(db, campaign.id, ALICE, "player");
  await addRaw(db, campaign.id, BOB, "player");
  return campaign;
}

export async function addRaw(db: Db, campaignId: number, userId: string, role: MemberRole): Promise<void> {
  await upsertMember(db, campaignId, userId, role);
}
