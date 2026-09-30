import type { Db, Queryable } from "../db/db.js";
import { findGuildSettings, upsertGuildSettings } from "../db/repositories/guildSettings.js";
import { listMembershipsInGuild } from "../db/repositories/members.js";
import { listGuildScheduledSessions, shiftSessionTimes } from "../db/repositories/sessions.js";
import { PermissionDeniedError, UserError } from "../domain/errors.js";
import type { Actor } from "../domain/permissions.js";
import { assertTimezone, endOfLocalDay, localDateOf, localDateTimeToUtc, localTimeOf, parseLocalTime } from "../domain/time.js";
import type { GuildSettings } from "../domain/types.js";

export async function requireGuildSettings(db: Queryable, guildId: string): Promise<GuildSettings> {
  const settings = await findGuildSettings(db, guildId);
  if (!settings) throw new UserError("This server has no calendar yet. A server admin needs to run `/calendar setup` first.");
  return settings;
}

/**
 * Creates or changes the server calendar (channel + timezone). Server admins only.
 *
 * Changing the timezone keeps every scheduled session at the same clock time
 * (18:00 stays 18:00, now in the new zone): the group plans in clock time,
 * and a timezone change usually corrects a wrong setting. `timezoneChanged`
 * tells the caller to redraw the session cards.
 */
export async function setupServerCalendar(
  db: Db,
  actor: Actor,
  input: { timezone: string; calendarChannelId: string },
): Promise<GuildSettings & { timezoneChanged: boolean }> {
  if (!actor.isGuildAdmin) throw new PermissionDeniedError("Only server administrators can set up the calendar.");
  const timezone = assertTimezone(input.timezone);
  return db.transaction(async (tx) => {
    const previous = await findGuildSettings(tx, actor.guildId);
    const settings = await upsertGuildSettings(tx, actor.guildId, { timezone, calendarChannelId: input.calendarChannelId });
    const timezoneChanged = previous !== null && previous.timezone !== timezone;
    if (timezoneChanged) {
      const move = (instant: Date) => sameClockTime(instant, previous.timezone, timezone);
      for (const session of await listGuildScheduledSessions(tx, actor.guildId)) {
        const startsAt = move(session.startsAt);
        await shiftSessionTimes(tx, session.id, {
          startsAt,
          endsAt: endOfLocalDay(startsAt, timezone),
          previousStartsAt: session.previousStartsAt && move(session.previousStartsAt),
          cardStartsAt: session.cardStartsAt && move(session.cardStartsAt),
        });
      }
    }
    return { ...settings, timezoneChanged };
  });
}

/** The instant with the same local date and clock time in another zone. */
function sameClockTime(instant: Date, from: string, to: string): Date {
  try {
    return localDateTimeToUtc(localDateOf(instant, from), parseLocalTime(localTimeOf(instant, from)), to);
  } catch {
    return instant; // that clock time doesn't exist there (daylight saving gap): keep the moment
  }
}

/**
 * People who take part in any campaign on the server (or server admins).
 * They may see who is unavailable; members may set their own availability.
 */
export async function isParticipant(db: Queryable, actor: Actor): Promise<boolean> {
  return (await listMembershipsInGuild(db, actor.guildId, actor.userId)).size > 0;
}
