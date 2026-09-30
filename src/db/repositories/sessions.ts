import type { Session, SessionStatus } from "../../domain/types.js";
import type { Queryable } from "../db.js";

/**
 * Sessions are read from the `session_numbered` view, which adds each
 * session's number (see migration 0006). Writes go to `session` and then
 * re-read the row so the number is current.
 */
interface SessionRow {
  id: number;
  campaign_id: number;
  title: string | null;
  display_number: number | null;
  starts_at: Date;
  ends_at: Date;
  notes: string | null;
  created_by: string;
  status: SessionStatus;
  schedule_changed_at: Date;
  discord_channel_id: string | null;
  discord_message_id: string | null;
  card_starts_at: Date | null;
  previous_starts_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  campaignId: r.campaign_id,
  title: r.title,
  number: r.display_number,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  notes: r.notes,
  createdBy: r.created_by,
  status: r.status,
  scheduleChangedAt: r.schedule_changed_at,
  discordChannelId: r.discord_channel_id,
  discordMessageId: r.discord_message_id,
  cardStartsAt: r.card_starts_at,
  previousStartsAt: r.previous_starts_at,
  cancelReason: r.cancel_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function reload(db: Queryable, id: number | undefined): Promise<Session> {
  const session = id === undefined ? null : await findSession(db, id);
  if (!session) throw new Error(`session ${id} not found after write`);
  return session;
}

export interface NewSession {
  campaignId: number;
  title: string | null;
  startsAt: Date;
  endsAt: Date;
  notes: string | null;
  createdBy: string;
  scheduledAt: Date;
}

export async function insertSession(db: Queryable, s: NewSession): Promise<Session> {
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO session (campaign_id, title, starts_at, ends_at, notes, created_by, schedule_changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [s.campaignId, s.title, s.startsAt, s.endsAt, s.notes, s.createdBy, s.scheduledAt],
  );
  return reload(db, row?.id);
}

export async function findSession(
  db: Queryable,
  id: number,
  opts: { lock?: "update" | "share" } = {},
): Promise<Session | null> {
  // The view can't be locked (it has a window function), so lock the row itself first.
  if (opts.lock) await db.query(`SELECT 1 FROM session WHERE id = $1 FOR ${opts.lock === "update" ? "UPDATE" : "SHARE"}`, [id]);
  const [row] = await db.query<SessionRow>("SELECT * FROM session_numbered WHERE id = $1", [id]);
  return row ? toSession(row) : null;
}

export interface SessionUpdate {
  title: string | null;
  startsAt: Date;
  endsAt: Date;
  notes: string | null;
  /** Set when the start time changed. */
  scheduleChangedAt: Date | null;
  /** The old start time, set when the start time changed. */
  previousStartsAt: Date | null;
}

export async function updateSession(db: Queryable, id: number, u: SessionUpdate): Promise<Session> {
  await db.query(
    `UPDATE session SET title = $2, starts_at = $3, ends_at = $4, notes = $5,
       schedule_changed_at = COALESCE($6, schedule_changed_at),
       previous_starts_at = COALESCE($7, previous_starts_at),
       updated_at = now()
     WHERE id = $1`,
    [id, u.title, u.startsAt, u.endsAt, u.notes, u.scheduleChangedAt, u.previousStartsAt],
  );
  return reload(db, id);
}

/** Cancels a session; it keeps the number it had. */
export async function cancelSessionRow(db: Queryable, id: number, reason: string | null): Promise<Session> {
  await db.query(
    `UPDATE session SET status = 'cancelled', cancel_reason = $2, updated_at = now(),
       number = (SELECT display_number FROM session_numbered WHERE id = $1)
     WHERE id = $1`,
    [id, reason],
  );
  return reload(db, id);
}

/**
 * Keeps a session's clock time when the server timezone changes: its start,
 * end and the times shown on its card move to the new zone.
 */
export async function shiftSessionTimes(
  db: Queryable,
  id: number,
  t: { startsAt: Date; endsAt: Date; previousStartsAt: Date | null; cardStartsAt: Date | null },
): Promise<void> {
  await db.query(
    "UPDATE session SET starts_at = $2, ends_at = $3, previous_starts_at = $4, card_starts_at = $5, updated_at = now() WHERE id = $1",
    [id, t.startsAt, t.endsAt, t.previousStartsAt, t.cardStartsAt],
  );
}

/** Records the posted session card; null clears it. */
export async function setSessionCard(
  db: Queryable,
  id: number,
  card: { channelId: string; messageId: string; startsAt: Date } | null,
): Promise<void> {
  await db.query(
    "UPDATE session SET discord_channel_id = $2, discord_message_id = $3, card_starts_at = $4 WHERE id = $1",
    [id, card?.channelId ?? null, card?.messageId ?? null, card?.startsAt ?? null],
  );
}

/**
 * Sessions whose card may need posting or removing: every session with a
 * card, and scheduled sessions that haven't ended and start within `horizon`.
 */
export async function listCardCandidates(db: Queryable, now: Date, until: Date): Promise<Session[]> {
  const rows = await db.query<SessionRow>(
    `SELECT * FROM session_numbered
     WHERE discord_message_id IS NOT NULL
        OR (status = 'scheduled' AND ends_at > $1 AND starts_at <= $2)
     ORDER BY starts_at, id`,
    [now, until],
  );
  return rows.map(toSession);
}

/** IDs of the server's sessions that have a posted card. */
export async function listGuildCardSessionIds(db: Queryable, guildId: string): Promise<number[]> {
  const rows = await db.query<{ id: number }>(
    `SELECT s.id FROM session s JOIN campaign c ON c.id = s.campaign_id
     WHERE c.guild_id = $1 AND s.discord_message_id IS NOT NULL ORDER BY s.starts_at, s.id`,
    [guildId],
  );
  return rows.map((r) => r.id);
}

/** Posted cards of a campaign's sessions (to delete them along with the campaign). */
export async function listCampaignCards(db: Queryable, campaignId: number): Promise<{ channelId: string; messageId: string }[]> {
  return db.query<{ channelId: string; messageId: string }>(
    `SELECT discord_channel_id AS "channelId", discord_message_id AS "messageId" FROM session
     WHERE campaign_id = $1 AND discord_channel_id IS NOT NULL AND discord_message_id IS NOT NULL`,
    [campaignId],
  );
}

/** Sessions of a campaign overlapping [from, to). */
export async function listSessionsBetween(db: Queryable, campaignId: number, from: Date, to: Date): Promise<Session[]> {
  const rows = await db.query<SessionRow>(
    `SELECT * FROM session_numbered WHERE campaign_id = $1 AND starts_at < $3 AND ends_at > $2 ORDER BY starts_at`,
    [campaignId, from, to],
  );
  return rows.map(toSession);
}

export async function listUpcomingSessions(
  db: Queryable,
  campaignIds: readonly number[],
  now: Date,
  limit = 25,
): Promise<Session[]> {
  const rows = await db.query<SessionRow>(
    `SELECT * FROM session_numbered WHERE campaign_id = ANY($1::int[]) AND status = 'scheduled' AND ends_at > $2
     ORDER BY starts_at LIMIT $3`,
    [campaignIds, now, limit],
  );
  return rows.map(toSession);
}

/** The server's scheduled sessions (to move them when the timezone changes). */
export async function listGuildScheduledSessions(db: Queryable, guildId: string): Promise<Session[]> {
  const rows = await db.query<SessionRow>(
    `SELECT s.* FROM session_numbered s JOIN campaign c ON c.id = s.campaign_id
     WHERE c.guild_id = $1 AND s.status = 'scheduled' ORDER BY s.starts_at, s.id`,
    [guildId],
  );
  return rows.map(toSession);
}

/**
 * Marks scheduled sessions that have ended as completed, in date order. Each
 * one takes the next number and becomes its campaign's current session.
 * Call inside a transaction.
 */
export async function completeEndedSessions(db: Queryable, now: Date): Promise<Session[]> {
  const ended = await db.query<{ id: number; campaign_id: number }>(
    "SELECT id, campaign_id FROM session WHERE status = 'scheduled' AND ends_at <= $1 ORDER BY starts_at, id FOR UPDATE",
    [now],
  );
  const completed: Session[] = [];
  for (const { id, campaign_id } of ended) {
    const [campaign] = await db.query<{ current_session: number }>(
      "UPDATE campaign SET current_session = current_session + 1, updated_at = now() WHERE id = $1 RETURNING current_session",
      [campaign_id],
    );
    await db.query("UPDATE session SET status = 'completed', number = $2, updated_at = now() WHERE id = $1", [
      id,
      campaign!.current_session,
    ]);
    completed.push(await reload(db, id));
  }
  return completed;
}

/** All sessions in the guild (any campaign) overlapping [from, to). */
export async function listGuildSessionsBetween(db: Queryable, guildId: string, from: Date, to: Date): Promise<Session[]> {
  const rows = await db.query<SessionRow>(
    `SELECT s.* FROM session_numbered s JOIN campaign c ON c.id = s.campaign_id
     WHERE c.guild_id = $1 AND s.starts_at < $3 AND s.ends_at > $2
     ORDER BY s.starts_at, s.id`,
    [guildId, from, to],
  );
  return rows.map(toSession);
}

/** Moves a session to another campaign; it takes its place in that campaign's numbering. */
export async function setSessionCampaign(db: Queryable, id: number, campaignId: number): Promise<Session> {
  await db.query("UPDATE session SET campaign_id = $2, updated_at = now() WHERE id = $1", [id, campaignId]);
  return reload(db, id);
}

/** The campaign's most recently created non-cancelled session, used to prefill the usual start time. */
export async function findLatestSession(db: Queryable, campaignId: number): Promise<Session | null> {
  const [row] = await db.query<SessionRow>(
    "SELECT * FROM session_numbered WHERE campaign_id = $1 AND status <> 'cancelled' ORDER BY created_at DESC, id DESC LIMIT 1",
    [campaignId],
  );
  return row ? toSession(row) : null;
}
