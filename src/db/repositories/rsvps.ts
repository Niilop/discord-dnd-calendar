import type { Rsvp, RsvpStatus } from "../../domain/types.js";
import type { Queryable } from "../db.js";

interface RsvpRow {
  session_id: number;
  discord_user_id: string;
  status: RsvpStatus;
  updated_at: Date;
}

const toRsvp = (r: RsvpRow): Rsvp => ({
  sessionId: r.session_id,
  userId: r.discord_user_id,
  status: r.status,
  updatedAt: r.updated_at,
});

export async function listRsvps(db: Queryable, sessionId: number): Promise<Rsvp[]> {
  const rows = await db.query<RsvpRow>("SELECT * FROM session_rsvp WHERE session_id = $1", [sessionId]);
  return rows.map(toRsvp);
}

export async function listRsvpsForSessions(db: Queryable, sessionIds: readonly number[]): Promise<Rsvp[]> {
  if (!sessionIds.length) return [];
  const rows = await db.query<RsvpRow>("SELECT * FROM session_rsvp WHERE session_id = ANY($1::int[])", [sessionIds]);
  return rows.map(toRsvp);
}

/** Returns the previous status (null if there was no response before). */
export async function upsertRsvp(
  db: Queryable,
  sessionId: number,
  userId: string,
  status: RsvpStatus,
): Promise<RsvpStatus | null> {
  const [prev] = await db.query<{ status: RsvpStatus }>(
    "SELECT status FROM session_rsvp WHERE session_id = $1 AND discord_user_id = $2 FOR UPDATE",
    [sessionId, userId],
  );
  await db.query(
    `INSERT INTO session_rsvp (session_id, discord_user_id, status) VALUES ($1, $2, $3)
     ON CONFLICT (session_id, discord_user_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
    [sessionId, userId, status],
  );
  return prev?.status ?? null;
}

/** Removes a user's responses to a campaign's sessions that have not ended yet. */
export async function deleteFutureRsvpsForUser(db: Queryable, campaignId: number, userId: string, now: Date): Promise<void> {
  await db.query(
    `DELETE FROM session_rsvp r USING session s
     WHERE r.session_id = s.id AND s.campaign_id = $1 AND r.discord_user_id = $2 AND s.ends_at > $3`,
    [campaignId, userId, now],
  );
}

/** Drops responses from people who aren't members of the session's (new) campaign. */
export async function deleteRsvpsOfNonMembers(db: Queryable, sessionId: number, campaignId: number): Promise<void> {
  await db.query(
    `DELETE FROM session_rsvp r
     WHERE r.session_id = $1
       AND NOT EXISTS (SELECT 1 FROM campaign_member m WHERE m.campaign_id = $2 AND m.discord_user_id = r.discord_user_id)`,
    [sessionId, campaignId],
  );
}
