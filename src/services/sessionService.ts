import type { Db, Queryable } from "../db/db.js";
import { findCampaign } from "../db/repositories/campaigns.js";
import { listMembers } from "../db/repositories/members.js";
import { deleteRsvpsOfNonMembers, listRsvps } from "../db/repositories/rsvps.js";
import {
  cancelSessionRow,
  findLatestSession,
  findSession,
  insertSession,
  listUpcomingSessions,
  setSessionCampaign,
  updateSession,
} from "../db/repositories/sessions.js";
import { NotFoundError, UserError } from "../domain/errors.js";
import { can, type Action, type Actor } from "../domain/permissions.js";
import { groupRsvps, type RsvpGroups } from "../domain/rsvp.js";
import { endOfLocalDay, localDateOf, localDateTimeToUtc, localTimeOf, parseLocalDate, parseLocalTime } from "../domain/time.js";
import {
  FALLBACK_START_TIME,
  type Campaign,
  type CampaignMember,
  type MemberRole,
  type Rsvp,
  type Session,
} from "../domain/types.js";
import { authorize, loadCampaign } from "./access.js";
import { listVisibleCampaigns } from "./campaignService.js";

export interface CreateSessionInput {
  /** Optional subtitle after "Session N". */
  title?: string | null;
  date: string;
  /** Defaults to the campaign's usual start time. */
  time?: string | null;
  notes?: string | null;
}

export interface EditSessionInput {
  /** Move the session to another campaign (its color and players change with it). */
  campaignId?: number | null;
  /** Empty string clears the subtitle. */
  title?: string | null;
  date?: string | null;
  time?: string | null;
  /** Empty string clears the notes. */
  notes?: string | null;
}

export interface SessionContext {
  session: Session;
  campaign: Campaign;
  role: MemberRole | null;
}

function normalizeTitle(title: string): string {
  const value = title.trim().replace(/\s+/g, " ");
  if (value.length < 1 || value.length > 100) throw new UserError("Session titles must be 1–100 characters.");
  return value;
}

function normalizeNotes(notes: string | null | undefined): string | null {
  const value = notes?.trim() ?? "";
  if (value.length > 1000) throw new UserError("Session notes can be at most 1000 characters.");
  return value || null;
}

/** The start time to prefill for a campaign's next session: whatever its most recent session used, or 18:00. */
export async function usualTime(db: Queryable, campaign: Campaign): Promise<string> {
  const latest = await findLatestSession(db, campaign.id);
  return latest ? localTimeOf(latest.startsAt, campaign.timezone) : FALLBACK_START_TIME;
}

/** Sessions have no length: one lasts until the end of its local day. */
function computeTimes(campaign: Campaign, date: string, time: string) {
  const startsAt = localDateTimeToUtc(parseLocalDate(date), parseLocalTime(time), campaign.timezone);
  return { startsAt, endsAt: endOfLocalDay(startsAt, campaign.timezone) };
}

/** Loads a session scoped to the actor's guild and checks `action` if given. */
export async function loadSession(
  db: Queryable,
  actor: Actor,
  sessionId: number,
  action: Action | null,
  opts: { lock?: "update" | "share" } = {},
): Promise<SessionContext> {
  const session = await findSession(db, sessionId, opts);
  if (!session) throw new NotFoundError("That session doesn't exist anymore.");
  const { campaign, role } = action
    ? await authorize(db, actor, session.campaignId, action)
    : await loadCampaign(db, actor, session.campaignId);
  return { session, campaign, role };
}

export async function createSession(
  db: Db,
  actor: Actor,
  campaignId: number,
  input: CreateSessionInput,
  now: Date = new Date(),
): Promise<{ session: Session; campaign: Campaign }> {
  return db.transaction(async (tx) => {
    const { campaign } = await authorize(tx, actor, campaignId, "session.create");
    const { startsAt, endsAt } = computeTimes(campaign, input.date, input.time || (await usualTime(tx, campaign)));
    if (startsAt <= now) throw new UserError("That start time is in the past.");
    const title = input.title?.trim() ? normalizeTitle(input.title) : null;
    const session = await insertSession(tx, {
      campaignId: campaign.id,
      title,
      startsAt,
      endsAt,
      notes: normalizeNotes(input.notes),
      createdBy: actor.userId,
      scheduledAt: now,
    });
    return { session, campaign };
  });
}

export interface CreateSessionsInput {
  dates: readonly string[];
  /** Defaults to the campaign's usual start time. */
  time?: string | null;
}

const MAX_BULK_SESSIONS = 31;

/** Creates one session per date in a single transaction — all or nothing. */
export async function createSessions(
  db: Db,
  actor: Actor,
  campaignId: number,
  input: CreateSessionsInput,
  now: Date = new Date(),
): Promise<{ sessions: Session[]; campaign: Campaign }> {
  const dates = [...new Set(input.dates.map(parseLocalDate))].sort();
  if (!dates.length) throw new UserError("Pick at least one date.");
  if (dates.length > MAX_BULK_SESSIONS) throw new UserError(`You can add at most ${MAX_BULK_SESSIONS} sessions at once.`);

  return db.transaction(async (tx) => {
    const { campaign } = await authorize(tx, actor, campaignId, "session.create");
    const time = input.time || (await usualTime(tx, campaign));
    const planned = dates.map((date) => ({ date, ...computeTimes(campaign, date, time) }));
    const past = planned.filter((p) => p.startsAt <= now);
    if (past.length) throw new UserError(`${past.map((p) => p.date).join(", ")} ${past.length === 1 ? "is" : "are"} already past that start time.`);

    const sessions: Session[] = [];
    for (const p of planned) {
      sessions.push(
        await insertSession(tx, {
          campaignId: campaign.id,
          title: null,
          startsAt: p.startsAt,
          endsAt: p.endsAt,
          notes: null,
          createdBy: actor.userId,
          scheduledAt: now,
        }),
      );
    }
    return { sessions, campaign };
  });
}

export async function editSession(
  db: Db,
  actor: Actor,
  sessionId: number,
  input: EditSessionInput,
  now: Date = new Date(),
): Promise<{
  session: Session;
  previous: Session;
  campaign: Campaign;
  previousCampaign: Campaign;
  timeChanged: boolean;
  moved: boolean;
}> {
  return db.transaction(async (tx) => {
    const { session: previous, campaign: previousCampaign } = await loadSession(tx, actor, sessionId, "session.edit", {
      lock: "update",
    });
    if (previous.status !== "scheduled") throw new UserError(`This session is ${previous.status} and can't be edited.`);

    // Moving to another campaign needs the right to schedule sessions there too.
    const moved = typeof input.campaignId === "number" && input.campaignId !== previous.campaignId;
    const campaign = moved ? (await authorize(tx, actor, input.campaignId as number, "session.create")).campaign : previousCampaign;

    const tz = campaign.timezone;
    const { startsAt, endsAt } = computeTimes(
      campaign,
      input.date || localDateOf(previous.startsAt, tz),
      input.time || localTimeOf(previous.startsAt, tz),
    );
    const timeChanged = startsAt.getTime() !== previous.startsAt.getTime();
    if (timeChanged && startsAt <= now) throw new UserError("The new start time is in the past.");

    let session = await updateSession(tx, previous.id, {
      title: input.title === undefined || input.title === null ? previous.title : input.title.trim() ? normalizeTitle(input.title) : null,
      startsAt,
      endsAt,
      notes: input.notes === undefined || input.notes === null ? previous.notes : normalizeNotes(input.notes),
      scheduleChangedAt: timeChanged ? now : null,
      previousStartsAt: timeChanged ? previous.startsAt : null,
    });
    if (moved) {
      session = await setSessionCampaign(tx, session.id, campaign.id);
      // RSVPs only make sense from the new campaign's players.
      await deleteRsvpsOfNonMembers(tx, session.id, campaign.id);
    }
    return { session, previous, campaign, previousCampaign, timeChanged, moved };
  });
}

export async function cancelSession(
  db: Db,
  actor: Actor,
  sessionId: number,
  reason: string | null = null,
): Promise<{ session: Session; campaign: Campaign }> {
  const cancelReason = reason?.trim() || null;
  if (cancelReason && cancelReason.length > 500) throw new UserError("The reason can be at most 500 characters.");
  return db.transaction(async (tx) => {
    const { session, campaign } = await loadSession(tx, actor, sessionId, "session.cancel", { lock: "update" });
    if (session.status !== "scheduled") throw new UserError(`This session is already ${session.status}.`);
    return { session: await cancelSessionRow(tx, session.id, cancelReason), campaign };
  });
}

export interface SessionOverview {
  session: Session;
  campaign: Campaign;
  members: CampaignMember[];
  rsvps: Rsvp[];
  groups: RsvpGroups;
}

/** Everything needed to render an RSVP card. Internal: no permission check. */
export async function getSessionOverview(db: Queryable, sessionId: number): Promise<SessionOverview | null> {
  const session = await findSession(db, sessionId);
  if (!session) return null;
  const [campaign, members, rsvps] = await Promise.all([
    findCampaign(db, session.campaignId),
    listMembers(db, session.campaignId),
    listRsvps(db, session.id),
  ]);
  if (!campaign) return null;
  return { session, campaign, members, rsvps, groups: groupRsvps(members, rsvps) };
}

/**
 * Upcoming scheduled sessions for autocomplete. With `action`, only sessions of
 * campaigns where the actor has that permission are returned.
 */
export async function listUpcomingForActor(
  db: Db,
  actor: Actor,
  action: Action,
  now: Date = new Date(),
): Promise<{ session: Session; campaign: Campaign }[]> {
  const visible = (await listVisibleCampaigns(db, actor)).filter((c) => can(actor, c.role, action));
  const byId = new Map(visible.map((c) => [c.campaign.id, c.campaign]));
  const sessions = await listUpcomingSessions(db, [...byId.keys()], now);
  return sessions.map((session) => ({ session, campaign: byId.get(session.campaignId)! }));
}
