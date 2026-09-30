import { PermissionDeniedError } from "./errors.js";
import type { MemberRole } from "./types.js";

/**
 * Everything a user can attempt against a campaign. Handlers never check
 * roles directly; they ask `can(actor, membership, action)`. Adding a new role
 * (e.g. 'scheduler') means adding it to MEMBER_ROLES + the CHECK constraint
 * and giving it a row in ROLE_PERMISSIONS below.
 */
export type Action =
  | "campaign.view"
  | "campaign.edit"
  | "campaign.delete"
  | "members.managePlayers"
  | "members.manageAdmins"
  | "session.create"
  | "session.edit"
  | "session.cancel"
  | "session.viewResponses"
  | "availability.viewOthers"
  | "availability.editOwn"
  | "rsvp.respond";

export interface Actor {
  userId: string;
  guildId: string;
  /** Has Manage Server (or Administrator) in the guild, as reported by Discord on this interaction. */
  isGuildAdmin: boolean;
}

// Who is unavailable on which day is public within a campaign.
const PLAYER_ACTIONS: readonly Action[] = ["campaign.view", "availability.viewOthers", "availability.editOwn", "rsvp.respond"];

const ROLE_PERMISSIONS: Record<MemberRole, ReadonlySet<Action>> = {
  player: new Set(PLAYER_ACTIONS),
  admin: new Set<Action>([
    ...PLAYER_ACTIONS,
    "campaign.edit",
    "members.managePlayers",
    "session.create",
    "session.edit",
    "session.cancel",
    "session.viewResponses",
  ]),
};

/**
 * Personal participation: only meaningful for campaign members, so even
 * server admins must be members to do these.
 */
const MEMBERSHIP_REQUIRED: ReadonlySet<Action> = new Set<Action>(["availability.editOwn", "rsvp.respond"]);

export function can(actor: Actor, role: MemberRole | null, action: Action): boolean {
  if (MEMBERSHIP_REQUIRED.has(action)) return role !== null && ROLE_PERMISSIONS[role].has(action);
  if (actor.isGuildAdmin) return true;
  return role !== null && ROLE_PERMISSIONS[role].has(action);
}

const DENIAL_MESSAGES: Partial<Record<Action, string>> = {
  "availability.editOwn": "You're not a member of this campaign, so you can't set availability for it.",
  "rsvp.respond": "You're not a member of this campaign, so you can't RSVP to its sessions.",
  "session.create": "Only the campaign's DMs/admins can create sessions.",
  "session.edit": "Only the campaign's DMs/admins can edit sessions.",
  "session.cancel": "Only the campaign's DMs/admins can cancel sessions.",
  "members.manageAdmins": "Only server administrators can add or remove campaign DMs/admins.",
  "campaign.delete": "Only server administrators can delete campaigns.",
};

export function assertCan(actor: Actor, role: MemberRole | null, action: Action): void {
  if (!can(actor, role, action)) {
    throw new PermissionDeniedError(DENIAL_MESSAGES[action]);
  }
}
