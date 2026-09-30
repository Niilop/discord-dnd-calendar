import type { Queryable } from "../db/db.js";
import { findCampaign } from "../db/repositories/campaigns.js";
import { findMemberRole } from "../db/repositories/members.js";
import { NotFoundError } from "../domain/errors.js";
import { assertCan, type Action, type Actor } from "../domain/permissions.js";
import type { Campaign, MemberRole } from "../domain/types.js";

export interface CampaignAccess {
  campaign: Campaign;
  role: MemberRole | null;
}

/**
 * Loads a campaign scoped to the actor's guild. IDs arrive from custom IDs and
 * autocomplete values, so a campaign from another guild is treated as missing.
 */
export async function loadCampaign(
  db: Queryable,
  actor: Actor,
  campaignId: number,
  opts: { forUpdate?: boolean } = {},
): Promise<CampaignAccess> {
  const campaign = await findCampaign(db, campaignId, opts);
  if (!campaign || campaign.guildId !== actor.guildId) {
    throw new NotFoundError("That campaign doesn't exist anymore.");
  }
  const role = await findMemberRole(db, campaign.id, actor.userId);
  return { campaign, role };
}

/** Loads the campaign and checks the permission against current database state. */
export async function authorize(
  db: Queryable,
  actor: Actor,
  campaignId: number,
  action: Action,
  opts: { forUpdate?: boolean } = {},
): Promise<CampaignAccess> {
  const access = await loadCampaign(db, actor, campaignId, opts);
  assertCan(actor, access.role, action);
  return access;
}
