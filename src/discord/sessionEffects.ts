import type { Campaign, Session } from "../domain/types.js";
import type { AppContext } from "./context.js";

/**
 * Discord side effects after a session mutation has been committed. The
 * database is already correct at this point; failures here are logged and
 * healed later (the scheduler re-syncs calendars and session cards).
 *
 * Nothing posts a separate notice: a session only ever has its one card in
 * the reminder channel, and only from the reminder window until its day ends.
 * Any change can renumber other upcoming sessions, so the other posted cards
 * are refreshed too.
 */

/** Sessions created inside the reminder window get their card right away. */
export async function afterSessionsCreated(ctx: AppContext, guildId: string, sessions: readonly Session[]): Promise<void> {
  for (const session of sessions) await ctx.publisher.syncSessionCard(session.id);
  await ctx.publisher.refreshGuildCards(guildId);
  await ctx.publisher.refreshCalendar(guildId);
}

export async function afterSessionEdited(ctx: AppContext, campaign: Campaign, session: Session, timeChanged: boolean): Promise<void> {
  await ctx.publisher.syncSessionCard(session.id, { announce: timeChanged, refresh: true });
  await ctx.publisher.refreshGuildCards(campaign.guildId, session.id);
  await ctx.publisher.refreshCalendar(campaign.guildId);
}

export async function afterSessionCancelled(ctx: AppContext, campaign: Campaign, session: Session): Promise<void> {
  await ctx.publisher.syncSessionCard(session.id, { announce: true });
  await ctx.publisher.refreshGuildCards(campaign.guildId, session.id);
  await ctx.publisher.refreshCalendar(campaign.guildId);
}
