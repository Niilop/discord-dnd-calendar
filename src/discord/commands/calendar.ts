import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { PermissionDeniedError, UserError } from "../../domain/errors.js";
import { findGuildSettings } from "../../db/repositories/guildSettings.js";
import { timezoneName } from "../../domain/time.js";
import { requireGuildSettings, setupServerCalendar } from "../../services/guildService.js";
import { replyPrivateCalendar } from "../privateCalendar.js";
import { actorFrom } from "../context.js";
import { messageUrl } from "../render/format.js";
import { privateCalendarView, schedulableCampaigns } from "../views.js";
import { assertBotCanPost, autocompleteTimezone, ephemeral, parseMonthOption, TEXT_CHANNEL_TYPES } from "./shared.js";
import type { SlashCommand } from "./types.js";

const data = new SlashCommandBuilder()
  .setName("calendar")
  .setDescription("The server's session calendar")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName("setup")
      .setDescription("Choose the calendar channel and the server timezone (server admins)")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel for the calendar").setRequired(true).addChannelTypes(...TEXT_CHANNEL_TYPES),
      )
      .addStringOption((o) =>
        o.setName("timezone").setDescription("The group's timezone, e.g. Central European Time or UTC+2").setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("show")
      .setDescription("Show a month of the calendar (only visible to you)")
      .addStringOption((o) => o.setName("month").setDescription("YYYY-MM, defaults to this month")),
  )
  .addSubcommand((s) => s.setName("refresh").setDescription("Re-post or refresh the calendar message (DMs/admins)"));

export const calendarCommand: SlashCommand = {
  name: data.name,
  toJSON: () => data.toJSON(),
  async execute(i, ctx) {
    const actor = actorFrom(i);
    switch (i.options.getSubcommand()) {
      case "setup": {
        const channel = i.options.getChannel("channel", true, TEXT_CHANNEL_TYPES);
        assertBotCanPost(channel);
        await i.deferReply(ephemeral);
        const settings = await setupServerCalendar(ctx.db, actor, {
          timezone: i.options.getString("timezone", true),
          calendarChannelId: channel.id,
        });
        await ctx.publisher.refreshCalendar(i.guildId);
        if (settings.timezoneChanged) await ctx.publisher.refreshGuildCards(i.guildId);
        await i.editReply(
          [
            `✅ The calendar lives in <#${settings.calendarChannelId}>; times are in **${timezoneName(settings.timezone)}**.`,
            settings.timezoneChanged ? "Scheduled sessions keep their clock time in the new timezone." : null,
            "Next: create campaigns with `/campaign create`, add players, then use **Add sessions** on the calendar.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        return;
      }
      case "show": {
        const settings = await requireGuildSettings(ctx.db, i.guildId);
        const month = parseMonthOption(i, settings.timezone, ctx.now());
        await replyPrivateCalendar(i, await privateCalendarView(ctx, actor, { mode: "view", month, campaignId: 0, mask: 0 }));
        return;
      }
      case "refresh": {
        if (!actor.isGuildAdmin && !(await schedulableCampaigns(ctx, actor)).length) {
          throw new PermissionDeniedError("Only DMs and server admins can refresh the calendar.");
        }
        await requireGuildSettings(ctx.db, i.guildId);
        await i.deferReply(ephemeral);
        await ctx.publisher.refreshCalendar(i.guildId);
        const settings = await findGuildSettings(ctx.db, i.guildId);
        if (ctx.publisher.staleCalendars.has(i.guildId) || !settings?.calendarMessageId || !settings.calendarMessageChannelId) {
          throw new UserError(`I couldn't update the calendar in <#${settings?.calendarChannelId}>. Check my permissions there.`);
        }
        await i.editReply(`✅ Calendar refreshed: ${messageUrl(i.guildId, settings.calendarMessageChannelId, settings.calendarMessageId)}`);
        return;
      }
      default:
        throw new UserError("Unknown subcommand.");
    }
  },
  async autocomplete(i) {
    await i.respond(autocompleteTimezone(i.options.getFocused()));
  },
};
