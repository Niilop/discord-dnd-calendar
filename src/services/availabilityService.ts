import type { Db, Queryable } from "../db/db.js";
import { deleteAvailability, listAvailability, upsertAvailability } from "../db/repositories/availability.js";
import { listCampaignsByGuild } from "../db/repositories/campaigns.js";
import { listGuildMemberIds, listMembers } from "../db/repositories/members.js";
import { listGuildSessionsBetween } from "../db/repositories/sessions.js";
import { summarizeAvailability, type DayAvailability } from "../domain/availability.js";
import { PermissionDeniedError, UserError } from "../domain/errors.js";
import type { Actor } from "../domain/permissions.js";
import { localDatesToUtcRange, parseLocalDate } from "../domain/time.js";
import type { AvailabilityStatus, AvailabilityValue, Campaign, GuildSettings, LocalDate, Session } from "../domain/types.js";
import { isParticipant, requireGuildSettings } from "./guildService.js";

const MAX_DATES_PER_CHANGE = 62;

const NOT_A_MEMBER = "You're not in any campaign on this server yet, so there's no availability to set. Ask a DM to add you.";

/**
 * Sets the acting user's own availability for the whole server. There is
 * deliberately no way to set someone else's.
 */
export async function setOwnAvailability(db: Db, actor: Actor, dates: readonly string[], value: AvailabilityValue): Promise<void> {
  const unique = [...new Set(dates.map(parseLocalDate))];
  if (!unique.length) throw new UserError("Pick at least one date.");
  if (unique.length > MAX_DATES_PER_CHANGE) throw new UserError(`You can change at most ${MAX_DATES_PER_CHANGE} dates at once.`);

  await db.transaction(async (tx) => {
    if (!(await isParticipant(tx, actor))) throw new PermissionDeniedError(NOT_A_MEMBER);
    if (value === "unspecified") await deleteAvailability(tx, actor.guildId, actor.userId, unique);
    else await upsertAvailability(tx, actor.guildId, actor.userId, unique, value);
  });
}

export async function getOwnAvailability(
  db: Db,
  actor: Actor,
  from: LocalDate,
  to: LocalDate,
): Promise<{ settings: GuildSettings; statuses: Map<LocalDate, AvailabilityStatus> }> {
  const settings = await requireGuildSettings(db, actor.guildId);
  if (!(await isParticipant(db, actor))) throw new PermissionDeniedError(NOT_A_MEMBER);
  const entries = await listAvailability(db, actor.guildId, from, to, actor.userId);
  return { settings, statuses: new Map(entries.map((e) => [e.date, e.status])) };
}

/** Per-day availability of one campaign's members (used when scheduling for that campaign). */
export async function summarizeCampaignDates(
  db: Queryable,
  campaign: Campaign,
  dates: readonly LocalDate[],
): Promise<Map<LocalDate, DayAvailability>> {
  if (!dates.length) return new Map();
  const [members, entries] = await Promise.all([
    listMembers(db, campaign.id),
    listAvailability(db, campaign.guildId, dates[0]!, dates.at(-1)!),
  ]);
  return summarizeAvailability(dates, members.map((m) => m.userId), entries);
}

/** Per-day availability of everyone in any campaign on the server (the server calendar). */
export async function summarizeGuildDates(
  db: Queryable,
  guildId: string,
  dates: readonly LocalDate[],
): Promise<{ summary: Map<LocalDate, DayAvailability>; memberCount: number }> {
  if (!dates.length) return { summary: new Map(), memberCount: 0 };
  const [memberIds, entries] = await Promise.all([
    listGuildMemberIds(db, guildId),
    listAvailability(db, guildId, dates[0]!, dates.at(-1)!),
  ]);
  return { summary: summarizeAvailability(dates, memberIds, entries), memberCount: memberIds.length };
}

export interface DayDetail {
  settings: GuildSettings;
  date: LocalDate;
  summary: DayAvailability;
  /** Who is unavailable is public to campaign members and server admins. */
  showNames: boolean;
  ownStatus: AvailabilityValue | null;
  sessions: { session: Session; campaign: Campaign }[];
}

export async function getDayDetail(db: Db, actor: Actor, date: string): Promise<DayDetail> {
  const day = parseLocalDate(date);
  const settings = await requireGuildSettings(db, actor.guildId);
  const participant = await isParticipant(db, actor);
  const { summary } = await summarizeGuildDates(db, actor.guildId, [day]);
  const daySummary = summary.get(day)!;
  const range = localDatesToUtcRange(day, day, settings.timezone);
  const [sessions, campaigns] = await Promise.all([
    listGuildSessionsBetween(db, actor.guildId, range.start, range.end),
    listCampaignsByGuild(db, actor.guildId),
  ]);
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  let ownStatus: AvailabilityValue | null = null;
  if (participant) {
    ownStatus = daySummary.unavailable.includes(actor.userId)
      ? "unavailable"
      : daySummary.preferNot.includes(actor.userId)
        ? "prefer_not"
        : "unspecified";
  }
  return {
    settings,
    date: day,
    summary: daySummary,
    showNames: participant || actor.isGuildAdmin,
    ownStatus,
    sessions: sessions.map((session) => ({ session, campaign: byId.get(session.campaignId)! })),
  };
}
