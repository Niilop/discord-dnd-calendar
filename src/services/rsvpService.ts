import type { Db } from "../db/db.js";
import { upsertRsvp } from "../db/repositories/rsvps.js";
import { UserError } from "../domain/errors.js";
import type { Actor } from "../domain/permissions.js";
import { rsvpBlockReason, type RsvpBlockReason } from "../domain/rsvp.js";
import type { Campaign, RsvpStatus, Session } from "../domain/types.js";
import { loadSession } from "./sessionService.js";

const BLOCKED_MESSAGES: Record<RsvpBlockReason, string> = {
  cancelled: "This session was cancelled, so RSVPs are closed.",
  completed: "This session has already happened.",
  ended: "This session has already ended.",
};

/**
 * Records the acting user's RSVP. The session row is share-locked so it
 * can't be cancelled/rescheduled halfway through the response.
 */
export async function respondToSession(
  db: Db,
  actor: Actor,
  sessionId: number,
  status: RsvpStatus,
  now: Date = new Date(),
): Promise<{ session: Session; campaign: Campaign; previous: RsvpStatus | null }> {
  return db.transaction(async (tx) => {
    const { session, campaign } = await loadSession(tx, actor, sessionId, "rsvp.respond", { lock: "share" });
    const blocked = rsvpBlockReason(session, now);
    if (blocked) throw new UserError(BLOCKED_MESSAGES[blocked]);
    const previous = await upsertRsvp(tx, session.id, actor.userId, status);
    return { session, campaign, previous };
  });
}
