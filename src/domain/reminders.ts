import { UserError } from "./errors.js";
import type { RsvpGroups } from "./rsvp.js";
import { endOfLocalDay } from "./time.js";
import type { Campaign, Session } from "./types.js";

/**
 * Session cards: each session has at most one message in its campaign's
 * reminder channel.
 *
 * - **live**: posted when the reminder window opens (or right away for a
 *   session created inside it) and kept until the session's day ends.
 * - **moved**: a live card whose session was moved outside the window turns
 *   into a short note, kept until the end of the day it used to be on.
 * - **cancelled**: a live card whose session was cancelled, kept until the
 *   end of that day.
 *
 * Everything is derived from the database, so the scheduler can re-run it
 * every tick and a missed tick just catches up.
 */
export type CardKind = "live" | "moved" | "cancelled";

export interface DesiredCard {
  kind: CardKind;
  channelId: string;
}

type CardSession = Pick<
  Session,
  "status" | "startsAt" | "endsAt" | "cardStartsAt" | "discordChannelId" | "discordMessageId"
>;
type CardCampaign = Pick<Campaign, "rsvpChannelId" | "reminderMinutes" | "timezone">;

const hasCard = (s: CardSession): boolean => s.discordChannelId !== null && s.discordMessageId !== null;

/**
 * The card a session should have right now, or null for none. `remind` (the
 * DMs' "remind now" button) opens the window early.
 */
export function desiredCard(
  session: CardSession,
  campaign: CardCampaign,
  now: Date,
  opts: { remind?: boolean } = {},
): DesiredCard | null {
  const channelId = campaign.rsvpChannelId;
  if (!channelId) return null;
  const cardFor = hasCard(session) ? session.cardStartsAt : null;

  if (session.status !== "cancelled" && now < endOfLocalDay(session.startsAt, campaign.timezone)) {
    const posted = cardFor?.getTime() === session.startsAt.getTime();
    const windowOpen =
      opts.remind === true ||
      (campaign.reminderMinutes !== null && now.getTime() >= session.startsAt.getTime() - campaign.reminderMinutes * 60_000);
    // A new card is only posted before the session ends; one already up stays until the day ends.
    if (posted || (windowOpen && now < session.endsAt)) return { kind: "live", channelId };
  }
  if (cardFor && now < endOfLocalDay(cardFor, campaign.timezone)) {
    return { kind: session.status === "cancelled" ? "cancelled" : "moved", channelId };
  }
  return null;
}

export type CardAction = "none" | "post" | "repost" | "edit" | "delete";

/**
 * How to get from the posted card to the desired one. A repost (post the new
 * message, delete the old) puts the card at the bottom of the channel, which
 * is how a change gets noticed without pinging anyone.
 *
 * - `announce`: the session was rescheduled, cancelled or reminded; repost.
 * - `refresh`: its details or RSVPs changed; edit in place.
 */
export function planCardSync(
  session: CardSession,
  desired: DesiredCard | null,
  opts: { announce?: boolean; refresh?: boolean } = {},
): CardAction {
  if (!desired) return hasCard(session) ? "delete" : "none";
  if (!hasCard(session)) return "post";
  if (session.discordChannelId !== desired.channelId) return "repost";
  if (desired.kind === "live" && session.cardStartsAt?.getTime() !== session.startsAt.getTime()) return "repost";
  if (opts.announce) return "repost";
  return opts.refresh ? "edit" : "none";
}

/**
 * Who a newly posted card would ping. Callers only use this when the
 * campaign has pings on, or for the explicit "remind now".
 */
export function cardPings(kind: CardKind, groups: RsvpGroups, reason: "new" | "changed" | "remind"): string[] {
  if (reason === "remind") return groups.noResponse;
  if (kind === "cancelled") return [...groups.attending, ...groups.maybe];
  if (kind === "live" && reason === "new") return groups.noResponse;
  return [...groups.attending, ...groups.maybe, ...groups.noResponse];
}

/** Parses hours before a session ("48", "24.5") into minutes; "off" disables automatic cards. */
export function parseReminderHours(input: string): number | null {
  if (input.trim().toLowerCase() === "off") return null;
  const minutes = Math.round(Number(input.trim()) * 60);
  if (!input.trim() || !Number.isFinite(minutes) || minutes < 30 || minutes > 14 * 24 * 60) {
    throw new UserError(`"${input}" is not a valid reminder time. Use hours before the session, e.g. "48" (0.5–336), or "off".`);
  }
  return minutes;
}
