import type { Queryable } from "../db/db.js";
import { listCampaignsByGuild } from "../db/repositories/campaigns.js";
import { listMembers } from "../db/repositories/members.js";
import { listRsvpsForSessions } from "../db/repositories/rsvps.js";
import { listGuildSessionsBetween } from "../db/repositories/sessions.js";
import type { DayAvailability } from "../domain/availability.js";
import { daysInMonth, localDatesToUtcRange, localDateOf, todayIn } from "../domain/time.js";
import type { Campaign, GuildSettings, LocalDate, RsvpStatus, Session, YearMonth } from "../domain/types.js";
import { summarizeGuildDates } from "./availabilityService.js";

export interface CalendarSession {
  session: Session;
  campaign: Campaign;
  localDate: LocalDate;
  counts: Record<RsvpStatus, number> & { noResponse: number };
}

export interface CalendarMonthView {
  settings: GuildSettings;
  month: YearMonth;
  today: LocalDate;
  days: LocalDate[];
  /** Everyone in any campaign on the server. */
  memberCount: number;
  /** All campaigns on the server (for the color legend). */
  campaigns: Campaign[];
  sessions: CalendarSession[];
  availability: Map<LocalDate, DayAvailability>;
}

/** Read model for the server calendar: every campaign's sessions, colored by campaign. */
export async function buildMonthView(
  db: Queryable,
  settings: GuildSettings,
  month: YearMonth,
  now: Date = new Date(),
): Promise<CalendarMonthView> {
  const tz = settings.timezone;
  const days = daysInMonth(month);
  const range = localDatesToUtcRange(days[0]!, days.at(-1)!, tz);
  const [sessionsRaw, campaigns, { summary, memberCount }] = await Promise.all([
    listGuildSessionsBetween(db, settings.guildId, range.start, range.end),
    listCampaignsByGuild(db, settings.guildId),
    summarizeGuildDates(db, settings.guildId, days),
  ]);
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  // Sessions belong to the month in which they start.
  const inMonth = sessionsRaw.filter((s) => localDateOf(s.startsAt, tz).startsWith(month));
  const [rsvps, memberLists] = await Promise.all([
    listRsvpsForSessions(db, inMonth.map((s) => s.id)),
    Promise.all([...new Set(inMonth.map((s) => s.campaignId))].map(async (id) => [id, await listMembers(db, id)] as const)),
  ]);
  const membersByCampaign = new Map(memberLists.map(([id, members]) => [id, new Set(members.map((m) => m.userId))]));

  const sessions = inMonth.map((session): CalendarSession => {
    const counts = { attending: 0, maybe: 0, absent: 0, noResponse: 0 };
    const responded = new Set<string>();
    for (const r of rsvps) {
      if (r.sessionId !== session.id) continue;
      counts[r.status] += 1;
      responded.add(r.userId);
    }
    counts.noResponse = [...(membersByCampaign.get(session.campaignId) ?? [])].filter((id) => !responded.has(id)).length;
    return { session, campaign: byId.get(session.campaignId)!, localDate: localDateOf(session.startsAt, tz), counts };
  });

  return { settings, month, today: todayIn(tz, now), days, memberCount, campaigns, sessions, availability: summary };
}
