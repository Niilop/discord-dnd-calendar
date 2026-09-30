import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import { colorToInt } from "../../domain/color.js";
import { RSVP_LABELS } from "../../domain/rsvp.js";
import type { CardKind } from "../../domain/reminders.js";
import { discordTimestamp, formatDayShort, formatSessionTime, localDateOf, localTimeOf } from "../../domain/time.js";
import type { RsvpStatus, Session, Campaign } from "../../domain/types.js";
import type { SessionOverview } from "../../services/sessionService.js";
import { encodeCustomId } from "../customIds.js";
import { COLORS, mention, mentionList, messageUrl, truncate } from "./format.js";

export const RSVP_EMOJI: Record<RsvpStatus, string> = { attending: "✅", maybe: "❔", absent: "❌" };
const RSVP_STYLE: Record<RsvpStatus, ButtonStyle> = {
  attending: ButtonStyle.Success,
  maybe: ButtonStyle.Secondary,
  absent: ButtonStyle.Danger,
};

/** "Session 14" or "Session 14: Into the Castle". */
export function sessionLabel(session: Pick<Session, "number" | "title">): string {
  const base = session.number === null ? "Session" : `Session ${session.number}`;
  return session.title ? `${base}: ${session.title}` : base;
}

export function sessionHeading(campaign: Campaign, session: Session): string {
  return `${campaign.name} — ${sessionLabel(session)}`;
}

export function sessionWhen(campaign: Campaign, session: Session): string {
  return `**${formatSessionTime(session.startsAt, campaign.timezone)}**\n` +
    `${discordTimestamp(session.startsAt, "F")} your time · ${discordTimestamp(session.startsAt, "R")}`;
}

export function rsvpButtons(sessionId: number): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    (Object.keys(RSVP_LABELS) as RsvpStatus[]).map((status) =>
      new ButtonBuilder()
        .setCustomId(encodeCustomId({ kind: "rsvp", sessionId, status }))
        .setLabel(RSVP_LABELS[status])
        .setEmoji(RSVP_EMOJI[status])
        .setStyle(RSVP_STYLE[status]),
    ),
  );
}

type CardPayload = {
  content?: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
};

/** "Thu 1 Oct 18:00" in the campaign timezone. */
function shortWhen(campaign: Campaign, instant: Date): string {
  return `${formatDayShort(localDateOf(instant, campaign.timezone))} ${localTimeOf(instant, campaign.timezone)}`;
}

export function renderRsvpCard(overview: SessionOverview): CardPayload {
  const { session, campaign, groups } = overview;
  const status = session.status;
  const moved = session.previousStartsAt ? `📅 Moved from ${shortWhen(campaign, session.previousStartsAt)}` : "";
  const reason = status === "cancelled" && session.cancelReason ? `> ${session.cancelReason}` : "";
  const embed = new EmbedBuilder()
    .setColor(status === "scheduled" ? colorToInt(campaign.color) : status === "cancelled" ? COLORS.danger : COLORS.muted)
    .setTitle(truncate(`${status === "cancelled" ? "❌ CANCELLED — " : ""}${sessionHeading(campaign, session)}`, 256))
    .setDescription(
      truncate([sessionWhen(campaign, session), moved, reason, session.notes ? `\n${session.notes}` : ""].filter(Boolean).join("\n"), 4096),
    )
    .addFields(
      { name: `${RSVP_EMOJI.attending} Attending (${groups.attending.length})`, value: mentionList(groups.attending), inline: true },
      { name: `${RSVP_EMOJI.maybe} Maybe (${groups.maybe.length})`, value: mentionList(groups.maybe), inline: true },
      { name: `${RSVP_EMOJI.absent} Can't attend (${groups.absent.length})`, value: mentionList(groups.absent), inline: true },
    );
  if (status === "scheduled" && groups.noResponse.length) {
    embed.addFields({ name: `⏳ No response (${groups.noResponse.length})`, value: mentionList(groups.noResponse) });
  }
  embed.setFooter({
    text:
      status === "scheduled"
        ? "You can change your answer any time before the session ends."
        : status === "cancelled"
          ? "This session was cancelled."
          : "This session has ended.",
  });
  return { embeds: [embed], components: status === "scheduled" ? [rsvpButtons(session.id)] : [] };
}

/** What a live card turns into when its session moves outside the reminder window. */
function renderMovedNote(overview: SessionOverview): CardPayload {
  const { session, campaign } = overview;
  const was = session.cardStartsAt ?? session.previousStartsAt;
  const embed = new EmbedBuilder()
    .setColor(COLORS.muted)
    .setTitle(truncate(`📅 Moved — ${sessionHeading(campaign, session)}`, 256))
    .setDescription(
      [
        was ? `Was **${shortWhen(campaign, was)}**, now:` : "Now:",
        sessionWhen(campaign, session),
      ].join("\n"),
    )
    .setFooter({ text: "The session card will be posted again closer to the day." });
  return { embeds: [embed], components: [] };
}

/**
 * The session card in the reminder channel. `pingIds` are mentioned in the
 * message content (the only place a mention pings); mentions inside the
 * embed never ping.
 */
export function renderSessionCard(overview: SessionOverview, kind: CardKind, pingIds: readonly string[] = []): CardPayload {
  const payload = kind === "moved" ? renderMovedNote(overview) : renderRsvpCard(overview);
  if (pingIds.length) payload.content = truncate(pingIds.map(mention).join(" "), 2000);
  return payload;
}

export function cardUrlOf(campaign: Campaign, session: Session): string | null {
  return session.discordChannelId && session.discordMessageId
    ? messageUrl(campaign.guildId, session.discordChannelId, session.discordMessageId)
    : null;
}

/** DM-only overview of who has and hasn't responded. */
export function renderResponses(overview: SessionOverview): EmbedBuilder {
  const { session, campaign, groups } = overview;
  const url = cardUrlOf(campaign, session);
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(truncate(`Responses — ${sessionHeading(campaign, session)}`, 256))
    .setDescription(`${sessionWhen(campaign, session)}${url ? `\n[Open RSVP card](${url})` : ""}`)
    .addFields(
      { name: `${RSVP_EMOJI.attending} Attending (${groups.attending.length})`, value: mentionList(groups.attending) },
      { name: `${RSVP_EMOJI.maybe} Maybe (${groups.maybe.length})`, value: mentionList(groups.maybe) },
      { name: `${RSVP_EMOJI.absent} Can't attend (${groups.absent.length})`, value: mentionList(groups.absent) },
      { name: `⏳ No response (${groups.noResponse.length})`, value: mentionList(groups.noResponse, "Everyone has responded 🎉") },
    );
}
