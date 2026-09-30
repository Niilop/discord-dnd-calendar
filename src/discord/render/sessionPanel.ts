import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import { colorEmoji } from "../../domain/color.js";
import { formatSessionTime, localDateOf, localTimeOf, offsetLabel } from "../../domain/time.js";
import type { Campaign } from "../../domain/types.js";
import type { SessionOverview } from "../../services/sessionService.js";
import { encodeCustomId } from "../customIds.js";
import { truncate } from "./format.js";
import { sessionLabel } from "./rsvpCard.js";

export const SESSION_MODAL_FIELDS = { title: "title", date: "date", time: "time" } as const;

export interface SessionPanelView {
  overview: SessionOverview;
  /** Campaigns the session can be moved to (the actor can schedule there). */
  campaigns: Campaign[];
  notice?: string;
  confirmingCancel?: boolean;
}

/**
 * The picked session in the calendar's Edit sessions mode: its details, then
 * move to another campaign, change date & time, or cancel (with a confirm step).
 */
export function renderSessionControls({ overview, campaigns, notice, confirmingCancel }: SessionPanelView): {
  text: string;
  rows: ActionRowBuilder<MessageActionRowComponentBuilder>[];
} {
  const { session, campaign, groups } = overview;
  const sessionId = session.id;
  const lines = [
    `**${colorEmoji(campaign.color)} ${campaign.name} — ${sessionLabel(session)}**`,
    formatSessionTime(session.startsAt, campaign.timezone),
    `✅ ${groups.attending.length} attending · ❔ ${groups.maybe.length} maybe · ❌ ${groups.absent.length} can't · ⏳ ${groups.noResponse.length} no reply`,
    notice ?? null,
    confirmingCancel ? "**Cancel this session?**" : null,
  ];
  const row = (...components: MessageActionRowComponentBuilder[]) =>
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(components);

  const rows = confirmingCancel
    ? [
        row(
          new ButtonBuilder().setCustomId(encodeCustomId({ kind: "se.confirm", sessionId })).setLabel("Yes, cancel it").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(encodeCustomId({ kind: "se.view", sessionId })).setLabel("Keep it").setStyle(ButtonStyle.Secondary),
        ),
      ]
    : [
        ...(campaigns.length > 1
          ? [
              row(
                new StringSelectMenuBuilder()
                  .setCustomId(encodeCustomId({ kind: "se.camp", sessionId }))
                  .setPlaceholder("Move to another campaign…")
                  .addOptions(
                    campaigns.slice(0, 25).map((c) => ({
                      label: truncate(`Campaign: ${c.name}`, 100),
                      value: String(c.id),
                      emoji: colorEmoji(c.color),
                      default: c.id === campaign.id,
                    })),
                  ),
              ),
            ]
          : []),
        row(
          new ButtonBuilder()
            .setCustomId(encodeCustomId({ kind: "se.time", sessionId }))
            .setLabel("Change date & time")
            .setEmoji("🕒")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(encodeCustomId({ kind: "se.cancel", sessionId }))
            .setLabel("Cancel session")
            .setEmoji("❌")
            .setStyle(ButtonStyle.Danger),
        ),
      ];
  return { text: lines.filter((l) => l !== null).join("\n"), rows };
}

export function renderSessionTimeModal(overview: SessionOverview): ModalBuilder {
  const { session, campaign } = overview;
  const tz = campaign.timezone;
  const field = (customId: string, label: string, value: string, max: number, required = true) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(label.slice(0, 45))
        .setStyle(TextInputStyle.Short)
        .setValue(value)
        .setMaxLength(max)
        .setRequired(required),
    );
  return new ModalBuilder()
    .setCustomId(encodeCustomId({ kind: "se.timeset", sessionId: session.id }))
    .setTitle(truncate(`Edit ${sessionLabel({ ...session, title: null })}`, 45))
    .addComponents(
      field(SESSION_MODAL_FIELDS.date, "Date (YYYY-MM-DD)", localDateOf(session.startsAt, tz), 10),
      field(SESSION_MODAL_FIELDS.time, `Start time (${offsetLabel(session.startsAt, tz)})`, localTimeOf(session.startsAt, tz), 8),
      field(SESSION_MODAL_FIELDS.title, "Title (optional)", session.title ?? "", 100, false),
    );
}
