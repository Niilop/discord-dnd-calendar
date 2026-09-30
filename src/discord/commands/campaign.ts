import { InteractionContextType, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { colorEmoji } from "../../domain/color.js";
import { UserError } from "../../domain/errors.js";
import {
  addMember,
  createCampaign,
  deleteCampaign,
  getCampaignOverview,
  listVisibleCampaigns,
  removeMember,
  updateCampaign,
} from "../../services/campaignService.js";
import { actorFrom, type AppContext } from "../context.js";
import { renderCampaignInfo } from "../render/campaignInfo.js";
import {
  assertBotCanPost,
  autocompleteCampaign,
  autocompleteColor,
  ephemeral,
  resolveCampaignId,
  TEXT_CHANNEL_TYPES,
} from "./shared.js";
import type { SlashCommand } from "./types.js";

const data = new SlashCommandBuilder()
  .setName("campaign")
  .setDescription("Manage campaigns and their members")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName("create")
      .setDescription("Create a campaign (server admins)")
      .addStringOption((o) => o.setName("name").setDescription("Campaign name").setRequired(true).setMaxLength(100))
      .addStringOption((o) =>
        o.setName("color").setDescription("Calendar color: a name (red, teal…) or hex like #8e4ec6").setRequired(true).setAutocomplete(true),
      )
      .addUserOption((o) => o.setName("dm").setDescription("The DM (defaults to you)"))
      .addChannelOption((o) =>
        o
          .setName("reminder_channel")
          .setDescription("Optional: where session cards are posted before each session")
          .addChannelTypes(...TEXT_CHANNEL_TYPES),
      )
      .addIntegerOption((o) =>
        o.setName("current_session").setDescription("Number of the last session played (default 0: the next one is Session 1)").setMinValue(0),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("edit")
      .setDescription("Change campaign settings (DMs/admins)")
      .addStringOption((o) => o.setName("campaign").setDescription("Campaign to change").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("name").setDescription("New name").setMaxLength(100))
      .addStringOption((o) => o.setName("color").setDescription("Calendar color: a name (red, teal…) or hex like #8e4ec6").setAutocomplete(true))
      .addChannelOption((o) =>
        o
          .setName("reminder_channel")
          .setDescription("Where session cards are posted before each session")
          .addChannelTypes(...TEXT_CHANNEL_TYPES),
      )
      .addBooleanOption((o) => o.setName("no_reminders").setDescription("Turn off session cards (clears the reminder channel)"))
      .addIntegerOption((o) =>
        o.setName("current_session").setDescription("Number of the last session played; upcoming sessions renumber from it").setMinValue(0),
      )
      .addStringOption((o) =>
        o.setName("reminder_hours").setDescription('Hours before a session its card is posted, e.g. "48", or "off"'),
      )
      .addBooleanOption((o) => o.setName("reminder_pings").setDescription("Ping players when a session card is posted or changes (default off)")),
  )
  .addSubcommand((s) =>
    s
      .setName("info")
      .setDescription("Show campaign settings and members")
      .addStringOption((o) => o.setName("campaign").setDescription("Campaign").setAutocomplete(true)),
  )
  .addSubcommand((s) => s.setName("list").setDescription("List campaigns you can see"))
  .addSubcommand((s) =>
    s
      .setName("add-player")
      .setDescription("Add a player to a campaign (DMs/admins)")
      .addUserOption((o) => o.setName("user").setDescription("Player").setRequired(true))
      .addStringOption((o) => o.setName("campaign").setDescription("Campaign").setAutocomplete(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("add-dm")
      .setDescription("Make someone a DM/admin of a campaign (server admins)")
      .addUserOption((o) => o.setName("user").setDescription("DM").setRequired(true))
      .addStringOption((o) => o.setName("campaign").setDescription("Campaign").setAutocomplete(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("remove-member")
      .setDescription("Remove someone from a campaign (DMs/admins)")
      .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
      .addStringOption((o) => o.setName("campaign").setDescription("Campaign").setAutocomplete(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("delete")
      .setDescription("Delete a campaign and all its data (server admins)")
      .addStringOption((o) => o.setName("campaign").setDescription("Campaign").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("confirm_name").setDescription("Type the campaign name to confirm").setRequired(true)),
  );

type Handler = (i: ChatInputCommandInteraction<"cached">, ctx: AppContext) => Promise<void>;

const handlers: Record<string, Handler> = {
  async create(i, ctx) {
    const reminderChannel = i.options.getChannel("reminder_channel", false, TEXT_CHANNEL_TYPES);
    if (reminderChannel) assertBotCanPost(reminderChannel);
    const dm = i.options.getUser("dm") ?? i.user;
    if (dm.bot) throw new UserError("A bot can't be the DM.");

    await i.deferReply(ephemeral);
    const campaign = await createCampaign(ctx.db, actorFrom(i), {
      name: i.options.getString("name", true),
      rsvpChannelId: reminderChannel?.id ?? null,
      currentSession: i.options.getInteger("current_session"),
      dmUserId: dm.id,
      color: i.options.getString("color", true),
    });
    await ctx.publisher.refreshCalendar(campaign.guildId);
    await i.editReply(
      [
        `✅ Created ${colorEmoji(campaign.color)} **${campaign.name}** with <@${dm.id}> as DM.`,
        campaign.rsvpChannelId
          ? `Session cards go to <#${campaign.rsvpChannelId}>, 48h before each session.`
          : "No reminder channel, so no session cards are posted (set one later with `/campaign edit reminder_channel`).",
        "Next: add players with `/campaign add-player`, then use **Add sessions** on the calendar.",
      ].join("\n"),
    );
  },

  async edit(i, ctx) {
    const campaignId = await resolveCampaignId(i, ctx);
    const reminderChannel = i.options.getChannel("reminder_channel", false, TEXT_CHANNEL_TYPES);
    if (reminderChannel) assertBotCanPost(reminderChannel);
    const noReminders = i.options.getBoolean("no_reminders") === true;

    await i.deferReply(ephemeral);
    const campaign = await updateCampaign(ctx.db, actorFrom(i), campaignId, {
      name: i.options.getString("name") ?? undefined,
      rsvpChannelId: noReminders ? null : reminderChannel?.id,
      currentSession: i.options.getInteger("current_session") ?? undefined,
      reminderHours: i.options.getString("reminder_hours") ?? undefined,
      reminderPings: i.options.getBoolean("reminder_pings") ?? undefined,
      color: i.options.getString("color") ?? undefined,
    });
    await ctx.publisher.refreshCalendar(campaign.guildId);
    await ctx.publisher.refreshGuildCards(campaign.guildId); // name, color and numbers show on the cards
    const { members, role } = await getCampaignOverview(ctx.db, actorFrom(i), campaign.id);
    await i.editReply({ content: "✅ Campaign updated.", embeds: [renderCampaignInfo(campaign, members, role)] });
  },

  async info(i, ctx) {
    const campaignId = await resolveCampaignId(i, ctx);
    const { campaign, members, role } = await getCampaignOverview(ctx.db, actorFrom(i), campaignId);
    await i.reply({ ...ephemeral, embeds: [renderCampaignInfo(campaign, members, role)], allowedMentions: { parse: [] } });
  },

  async list(i, ctx) {
    const visible = await listVisibleCampaigns(ctx.db, actorFrom(i));
    const lines = visible.map(
      ({ campaign, role }) =>
        `${colorEmoji(campaign.color)} **${campaign.name}** — ${role ?? "not a member"}` +
        (campaign.rsvpChannelId ? ` · reminders in <#${campaign.rsvpChannelId}>` : ""),
    );
    await i.reply({ ...ephemeral, content: lines.join("\n") || "No campaigns you can see on this server." });
  },

  async "add-player"(i, ctx) {
    const user = i.options.getUser("user", true);
    if (user.bot) throw new UserError("Bots can't be campaign members.");
    const campaignId = await resolveCampaignId(i, ctx);
    const { campaign, previousRole } = await addMember(ctx.db, actorFrom(i), campaignId, user.id, "player");
    ctx.publisher.scheduleCalendarRefresh(campaign.guildId);
    await i.reply({
      ...ephemeral,
      content: previousRole ? `✅ <@${user.id}> is now a player (was DM/admin) in **${campaign.name}**.` : `✅ Added <@${user.id}> to **${campaign.name}**.`,
    });
  },

  async "add-dm"(i, ctx) {
    const user = i.options.getUser("user", true);
    if (user.bot) throw new UserError("Bots can't be campaign members.");
    const campaignId = await resolveCampaignId(i, ctx);
    const { campaign } = await addMember(ctx.db, actorFrom(i), campaignId, user.id, "admin");
    ctx.publisher.scheduleCalendarRefresh(campaign.guildId);
    await i.reply({ ...ephemeral, content: `✅ <@${user.id}> is now a DM/admin of **${campaign.name}**.` });
  },

  async "remove-member"(i, ctx) {
    const user = i.options.getUser("user", true);
    const campaignId = await resolveCampaignId(i, ctx);
    const { campaign } = await removeMember(ctx.db, actorFrom(i), campaignId, user.id, ctx.now());
    ctx.publisher.scheduleCalendarRefresh(campaign.guildId);
    await i.reply({
      ...ephemeral,
      content: `✅ Removed <@${user.id}> from **${campaign.name}**. Their RSVPs to upcoming sessions were removed.`,
    });
  },

  async delete(i, ctx) {
    const campaignId = await resolveCampaignId(i, ctx);
    await i.deferReply(ephemeral);
    const { campaign, cards } = await deleteCampaign(ctx.db, actorFrom(i), campaignId, i.options.getString("confirm_name", true));
    await ctx.publisher.deleteCards(cards);
    await ctx.publisher.refreshCalendar(campaign.guildId);
    await i.editReply(`🗑️ Deleted **${campaign.name}** and all of its sessions and RSVPs.`);
  },
};

export const campaignCommand: SlashCommand = {
  name: data.name,
  toJSON: () => data.toJSON(),
  async execute(i, ctx) {
    const handler = handlers[i.options.getSubcommand()];
    if (!handler) throw new UserError("Unknown subcommand.");
    await handler(i, ctx);
  },
  async autocomplete(i, ctx) {
    const focused = i.options.getFocused(true);
    if (focused.name === "color") return i.respond(autocompleteColor(focused.value));
    const sub = i.options.getSubcommand();
    const action = sub === "info" ? "campaign.view" : sub === "delete" ? "campaign.delete" : sub === "edit" ? "campaign.edit" : "members.managePlayers";
    await i.respond(await autocompleteCampaign(i, ctx, action));
  },
};
