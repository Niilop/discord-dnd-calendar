import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { UserError } from "../../domain/errors.js";
import { dateRange, formatDayShort, parseLocalDate } from "../../domain/time.js";
import type { AvailabilityValue } from "../../domain/types.js";
import { setOwnAvailability } from "../../services/availabilityService.js";
import { requireGuildSettings } from "../../services/guildService.js";
import { replyPrivateCalendar } from "../privateCalendar.js";
import { actorFrom } from "../context.js";
import { privateCalendarView } from "../views.js";
import { ephemeral, parseMonthOption } from "./shared.js";
import type { SlashCommand } from "./types.js";

const STATUS_CHOICES: { name: string; value: AvailabilityValue }[] = [
  { name: "Can't play", value: "unavailable" },
  { name: "Unsure", value: "prefer_not" },
  { name: "Clear my marks", value: "unspecified" },
];

const MAX_RANGE_DAYS = 62;

const data = new SlashCommandBuilder()
  .setName("availability")
  .setDescription("Mark the days you can't play (applies to every campaign)")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName("edit")
      .setDescription("Mark the days you can't play on your private calendar")
      .addStringOption((o) => o.setName("month").setDescription("YYYY-MM, defaults to this month")),
  )
  .addSubcommand((s) =>
    s
      .setName("range")
      .setDescription("Mark a range of days at once (e.g. a holiday)")
      .addStringOption((o) => o.setName("status").setDescription("What to mark").setRequired(true).addChoices(...STATUS_CHOICES))
      .addStringOption((o) => o.setName("from").setDescription("First day, YYYY-MM-DD").setRequired(true))
      .addStringOption((o) => o.setName("to").setDescription("Last day, YYYY-MM-DD (defaults to the first day)")),
  );

export const availabilityCommand: SlashCommand = {
  name: data.name,
  toJSON: () => data.toJSON(),
  async execute(i, ctx) {
    const actor = actorFrom(i, ctx);
    if (i.options.getSubcommand() === "edit") {
      const settings = await requireGuildSettings(ctx.db, i.guildId);
      const month = parseMonthOption(i, settings.timezone, ctx.now());
      await replyPrivateCalendar(i, await privateCalendarView(ctx, actor, { mode: "avail", month, campaignId: 0, mask: 0 }));
      return;
    }

    const from = parseLocalDate(i.options.getString("from", true));
    const to = parseLocalDate(i.options.getString("to") ?? from);
    if (to < from) throw new UserError("`to` must be on or after `from`.");
    const days = dateRange(from, MAX_RANGE_DAYS + 1).filter((d) => d <= to);
    if (days.length > MAX_RANGE_DAYS) throw new UserError(`A range can be at most ${MAX_RANGE_DAYS} days.`);
    const status = i.options.getString("status", true) as AvailabilityValue;

    await setOwnAvailability(ctx.db, actor, days, status);
    ctx.publisher.scheduleCalendarRefresh(i.guildId);
    const span = from === to ? formatDayShort(from) : `${formatDayShort(from)} – ${formatDayShort(to)}`;
    const label = STATUS_CHOICES.find((c) => c.value === status)!.name;
    await i.reply({ ...ephemeral, content: `✅ ${span}: **${label}**` });
  },
};
