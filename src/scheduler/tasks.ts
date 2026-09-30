import { findCampaign } from "../db/repositories/campaigns.js";
import { listGuildSettings } from "../db/repositories/guildSettings.js";
import { completeEndedSessions, listCardCandidates } from "../db/repositories/sessions.js";
import { todayIn } from "../domain/time.js";
import type { AppContext } from "../discord/context.js";

/**
 * A scheduler task runs every tick. Tasks are idempotent and derive what to
 * do from the database, so a missed tick (restart, deploy) just catches up.
 * New automatic behaviours are added as new tasks.
 */
export interface SchedulerTask {
  name: string;
  run(ctx: AppContext, now: Date): Promise<void>;
}

/** Longest supported reminder time (see parseReminderHours). */
const MAX_REMINDER_HORIZON_MS = 14 * 24 * 3_600_000;

export const completeSessionsTask: SchedulerTask = {
  name: "complete-sessions",
  async run(ctx, now) {
    const completed = await ctx.db.transaction((tx) => completeEndedSessions(tx, now));
    for (const session of completed) {
      ctx.log.info({ sessionId: session.id }, "session completed");
      await ctx.publisher.syncSessionCard(session.id, { refresh: true });
      const campaign = await findCampaign(ctx.db, session.campaignId);
      if (campaign) ctx.publisher.scheduleCalendarRefresh(campaign.guildId);
    }
  },
};

/**
 * Posts session cards as reminder windows open and deletes them once their
 * day is over. A failed post is simply tried again on the next tick.
 */
export const sessionCardsTask: SchedulerTask = {
  name: "session-cards",
  async run(ctx, now) {
    const candidates = await listCardCandidates(ctx.db, now, new Date(now.getTime() + MAX_REMINDER_HORIZON_MS));
    for (const session of candidates) await ctx.publisher.syncSessionCard(session.id);
  },
};

const STALE_RETRY_MS = 10 * 60_000;

/**
 * Keeps each server's calendar message current: re-renders when the local
 * day changes (month rollover, "today" marker) and retries failed refreshes
 * with a back-off. Everything renders once after startup.
 */
export function createCalendarTask(): SchedulerTask {
  const renderedDay = new Map<string, string>();
  const lastAttempt = new Map<string, number>();
  return {
    name: "calendars",
    async run(ctx, now) {
      for (const settings of await listGuildSettings(ctx.db)) {
        const guildId = settings.guildId;
        const today = todayIn(settings.timezone, now);
        const stale = ctx.publisher.staleCalendars.has(guildId);
        if (renderedDay.get(guildId) === today && !stale) continue;
        if (stale && now.getTime() - (lastAttempt.get(guildId) ?? 0) < STALE_RETRY_MS) continue;
        lastAttempt.set(guildId, now.getTime());
        await ctx.publisher.refreshCalendar(guildId);
        if (!ctx.publisher.staleCalendars.has(guildId)) renderedDay.set(guildId, today);
      }
    },
  };
}
