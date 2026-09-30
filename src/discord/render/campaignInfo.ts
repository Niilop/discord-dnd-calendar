import { EmbedBuilder } from "discord.js";
import { colorEmoji, colorToInt, describeColor } from "../../domain/color.js";
import type { Campaign, CampaignMember, MemberRole } from "../../domain/types.js";
import { mentionList } from "./format.js";

export function renderCampaignInfo(campaign: Campaign, members: CampaignMember[], viewerRole: MemberRole | null): EmbedBuilder {
  const admins = members.filter((m) => m.role === "admin").map((m) => m.userId);
  const players = members.filter((m) => m.role === "player").map((m) => m.userId);
  const reminders = !campaign.rsvpChannelId
    ? "off (no reminder channel)"
    : campaign.reminderMinutes !== null
      ? `session card ${+(campaign.reminderMinutes / 60).toFixed(1)}h before, in <#${campaign.rsvpChannelId}> · ${campaign.reminderPings ? "pings players" : "no pings"}`
      : "off";
  return new EmbedBuilder()
    .setColor(colorToInt(campaign.color))
    .setTitle(campaign.name)
    .addFields(
      { name: "Color", value: `${colorEmoji(campaign.color)} ${describeColor(campaign.color)}`, inline: true },
      { name: "Current session", value: `${campaign.currentSession} (next: ${campaign.currentSession + 1})`, inline: true },
      { name: "Your role", value: viewerRole ?? "not a member", inline: true },
      { name: "Reminders", value: reminders },
      { name: `DMs / admins (${admins.length})`, value: mentionList(admins) },
      { name: `Players (${players.length})`, value: mentionList(players) },
    )
    .setFooter({ text: `Campaign #${campaign.id}` });
}
