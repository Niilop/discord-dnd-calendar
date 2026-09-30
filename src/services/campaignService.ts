import type { Db } from "../db/db.js";
import {
  campaignNameExists,
  deleteCampaign as deleteCampaignRow,
  insertCampaign,
  listCampaignsByGuild,
  updateCampaign as updateCampaignRow,
  type CampaignPatch,
} from "../db/repositories/campaigns.js";
import { deleteMember, findMemberRole, listMembers, listMembershipsInGuild, upsertMember } from "../db/repositories/members.js";
import { deleteFutureRsvpsForUser } from "../db/repositories/rsvps.js";
import { listCampaignCards } from "../db/repositories/sessions.js";
import { DEFAULT_CAMPAIGN_COLOR, parseColor } from "../domain/color.js";
import { PermissionDeniedError, UserError } from "../domain/errors.js";
import { assertCan, type Actor } from "../domain/permissions.js";
import { parseReminderHours } from "../domain/reminders.js";
import type { Campaign, CampaignMember, MemberRole } from "../domain/types.js";
import { authorize } from "./access.js";
import { requireGuildSettings } from "./guildService.js";

export interface CreateCampaignInput {
  name: string;
  /** Reminder/notice channel; null for none. */
  rsvpChannelId: string | null;
  /** The last played session's number; defaults to 0 (the next session is Session 1). */
  currentSession?: number | null;
  /** Initial DM / campaign admin. */
  dmUserId: string;
  /** Palette name or hex; defaults to blue. */
  color?: string | null;
}

export interface UpdateCampaignInput {
  name?: string;
  /** null turns reminders off. */
  rsvpChannelId?: string | null;
  /** The last played session's number; upcoming sessions renumber from it. */
  currentSession?: number;
  /** e.g. "48", or "off". */
  reminderHours?: string;
  /** Whether session cards ping players. */
  reminderPings?: boolean;
  /** Palette name or hex. */
  color?: string;
}

function normalizeName(name: string): string {
  const value = name.trim().replace(/\s+/g, " ");
  if (value.length < 1 || value.length > 100) throw new UserError("Campaign names must be 1–100 characters.");
  return value;
}

function checkSessionNumber(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new UserError("The current session must be a whole number, 0 or more.");
  return n;
}


export async function createCampaign(db: Db, actor: Actor, input: CreateCampaignInput): Promise<Campaign> {
  if (!actor.isGuildAdmin) {
    throw new PermissionDeniedError("Only server administrators (Manage Server) can create campaigns.");
  }
  const name = normalizeName(input.name);
  const currentSession = checkSessionNumber(input.currentSession ?? 0);
  const color = input.color ? parseColor(input.color) : DEFAULT_CAMPAIGN_COLOR;

  return db.transaction(async (tx) => {
    await requireGuildSettings(tx, actor.guildId);
    if (await campaignNameExists(tx, actor.guildId, name)) {
      throw new UserError(`A campaign called "${name}" already exists on this server.`);
    }
    const campaign = await insertCampaign(tx, {
      guildId: actor.guildId,
      name,
      rsvpChannelId: input.rsvpChannelId,
      currentSession,
      color,
    });
    await upsertMember(tx, campaign.id, input.dmUserId, "admin");
    return campaign;
  });
}

export async function updateCampaign(db: Db, actor: Actor, campaignId: number, input: UpdateCampaignInput): Promise<Campaign> {
  const patch: CampaignPatch = {};
  if (input.name !== undefined) patch.name = normalizeName(input.name);
  if (input.rsvpChannelId !== undefined) patch.rsvpChannelId = input.rsvpChannelId;
  if (input.currentSession !== undefined) patch.currentSession = checkSessionNumber(input.currentSession);
  if (input.reminderHours !== undefined) patch.reminderMinutes = parseReminderHours(input.reminderHours);
  if (input.reminderPings !== undefined) patch.reminderPings = input.reminderPings;
  if (input.color !== undefined) patch.color = parseColor(input.color);
  if (!Object.keys(patch).length) throw new UserError("Nothing to change — pass at least one option.");

  return db.transaction(async (tx) => {
    const { campaign } = await authorize(tx, actor, campaignId, "campaign.edit", { forUpdate: true });
    if (patch.name && (await campaignNameExists(tx, campaign.guildId, patch.name, campaign.id))) {
      throw new UserError(`A campaign called "${patch.name}" already exists on this server.`);
    }
    return (await updateCampaignRow(tx, campaign.id, patch))!;
  });
}

/** Returns the deleted campaign and its sessions' posted cards, which the caller removes from Discord. */
export async function deleteCampaign(
  db: Db,
  actor: Actor,
  campaignId: number,
  confirmName: string,
): Promise<{ campaign: Campaign; cards: { channelId: string; messageId: string }[] }> {
  return db.transaction(async (tx) => {
    const { campaign } = await authorize(tx, actor, campaignId, "campaign.delete", { forUpdate: true });
    if (confirmName.trim().toLowerCase() !== campaign.name.toLowerCase()) {
      throw new UserError(`To confirm deletion, type the campaign name exactly: "${campaign.name}".`);
    }
    const cards = await listCampaignCards(tx, campaign.id);
    await deleteCampaignRow(tx, campaign.id);
    return { campaign, cards };
  });
}

export async function getCampaignOverview(
  db: Db,
  actor: Actor,
  campaignId: number,
): Promise<{ campaign: Campaign; members: CampaignMember[]; role: MemberRole | null }> {
  const { campaign, role } = await authorize(db, actor, campaignId, "campaign.view");
  return { campaign, members: await listMembers(db, campaign.id), role };
}

export async function addMember(
  db: Db,
  actor: Actor,
  campaignId: number,
  userId: string,
  role: MemberRole,
): Promise<{ campaign: Campaign; previousRole: MemberRole | null }> {
  return db.transaction(async (tx) => {
    const access = await authorize(tx, actor, campaignId, "members.managePlayers", { forUpdate: true });
    const previousRole = await findMemberRole(tx, campaignId, userId);
    // Granting or revoking admin is a bigger deal than managing players.
    if (role === "admin" || previousRole === "admin") assertCan(actor, access.role, "members.manageAdmins");
    if (previousRole === role) {
      throw new UserError(`<@${userId}> is already ${role === "admin" ? "a DM/admin" : "a player"} in ${access.campaign.name}.`);
    }
    await upsertMember(tx, campaignId, userId, role);
    return { campaign: access.campaign, previousRole };
  });
}

export async function removeMember(
  db: Db,
  actor: Actor,
  campaignId: number,
  userId: string,
  now: Date = new Date(),
): Promise<{ campaign: Campaign; previousRole: MemberRole }> {
  return db.transaction(async (tx) => {
    const access = await authorize(tx, actor, campaignId, "members.managePlayers", { forUpdate: true });
    const previousRole = await findMemberRole(tx, campaignId, userId);
    if (!previousRole) throw new UserError(`<@${userId}> is not a member of ${access.campaign.name}.`);
    if (previousRole === "admin") assertCan(actor, access.role, "members.manageAdmins");
    // Availability cascades via FK; RSVPs to past sessions are kept as history.
    await deleteMember(tx, campaignId, userId);
    await deleteFutureRsvpsForUser(tx, campaignId, userId, now);
    return { campaign: access.campaign, previousRole };
  });
}

/** Campaigns the actor can see in this guild: all for server admins, otherwise their memberships. */
export async function listVisibleCampaigns(
  db: Db,
  actor: Actor,
): Promise<{ campaign: Campaign; role: MemberRole | null }[]> {
  const [campaigns, memberships] = await Promise.all([
    listCampaignsByGuild(db, actor.guildId),
    listMembershipsInGuild(db, actor.guildId, actor.userId),
  ]);
  return campaigns
    .map((campaign) => ({ campaign, role: memberships.get(campaign.id) ?? null }))
    .filter((c) => actor.isGuildAdmin || c.role !== null);
}
