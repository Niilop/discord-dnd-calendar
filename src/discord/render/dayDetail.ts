import { EmbedBuilder } from "discord.js";
import { describeDayAvailability } from "../../domain/availability.js";
import { colorEmoji, colorToInt } from "../../domain/color.js";
import { formatDayLong, localDatesToUtcRange, localTimeOf, offsetLabel } from "../../domain/time.js";
import type { DayDetail } from "../../services/availabilityService.js";
import { COLORS, mentionList } from "./format.js";
import { sessionLabel } from "./rsvpCard.js";

const OWN_STATUS_TEXT = {
  unavailable: "🚫 You marked yourself **unavailable**.",
  prefer_not: "❔ You marked yourself **unsure**.",
  unspecified: "You haven't marked this day (available).",
} as const;

export function renderDayDetail(detail: DayDetail): EmbedBuilder {
  const { settings, summary } = detail;
  const lines: string[] = [];

  if (detail.sessions.length) {
    lines.push("**Sessions**");
    for (const { session, campaign } of detail.sessions) {
      const text = `${localTimeOf(session.startsAt, settings.timezone)} — ${campaign.name} · ${sessionLabel(session)}`;
      lines.push(`${colorEmoji(campaign.color)} ${session.status === "cancelled" ? `~~${text}~~ *(cancelled)*` : text}`);
    }
    lines.push("");
  }

  lines.push(`**Availability:** ${describeDayAvailability(summary)}`);
  if (detail.showNames) {
    if (summary.unavailable.length) lines.push(`🚫 Unavailable: ${mentionList(summary.unavailable)}`);
    if (summary.preferNot.length) lines.push(`❔ Unsure: ${mentionList(summary.preferNot)}`);
  }
  if (detail.ownStatus) lines.push("", OWN_STATUS_TEXT[detail.ownStatus]);

  const first = detail.sessions.find((s) => s.session.status !== "cancelled");
  return new EmbedBuilder()
    .setColor(first ? colorToInt(first.campaign.color) : COLORS.primary)
    .setTitle(formatDayLong(detail.date))
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Times in ${offsetLabel(localDatesToUtcRange(detail.date, detail.date, settings.timezone).start, settings.timezone)}` });
}
