import { ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionContextType, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { UserError } from "../../domain/errors.js";
import type { Action } from "../../domain/permissions.js";
import { discordTimestamp, formatSessionTime } from "../../domain/time.js";
import { authorize } from "../../services/access.js";
import { cancelSession, createSession, editSession, getSessionOverview, listUpcomingForActor, loadSession } from "../../services/sessionService.js";
import { replyPrivateCalendar } from "../privateCalendar.js";
import { actorFrom, type AppContext } from "../context.js";
import { encodeCustomId } from "../customIds.js";
import { cardUrlOf, renderResponses, sessionHeading, sessionLabel } from "../render/rsvpCard.js";
import { afterSessionCancelled, afterSessionEdited, afterSessionsCreated } from "../sessionEffects.js";
import { privateCalendarView } from "../views.js";
import { colorEmoji } from "../../domain/color.js";
import { requireGuildSettings } from "../../services/guildService.js";
import {
  autocompleteCampaign,
  autocompleteDate,
  autocompleteSession,
  ephemeral,
  parseMonthOption,
  resolveCampaignId,
} from "./shared.js";
import type { SlashCommand } from "./types.js";

const data = new SlashCommandBuilder()
  .setName("session")
  .setDescription("Schedule and manage sessions")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Add several sessions at once: pick a campaign, days and a start time (DMs/admins)")
      .addStringOption((o) => o.setName("campaign").setDescription("Campaign").setAutocomplete(true))
      .addStringOption((o) => o.setName("month").setDescription("YYYY-MM, defaults to this month")),
  )
  .addSubcommand((s) =>
    s
      .setName("create")
      .setDescription("Schedule a session directly (DMs/admins)")
      .addStringOption((o) =>
        o.setName("date").setDescription("Date (YYYY-MM-DD) — suggestions show availability").setRequired(true).setAutocomplete(true),
      )
      .addStringOption((o) => o.setName("campaign").setDescription("Campaign").setAutocomplete(true))
      .addStringOption((o) => o.setName("time").setDescription("Start time, e.g. 18:00 (defaults to the campaign's usual time)"))
      .addStringOption((o) => o.setName("title").setDescription('Optional title after the number: "Session 14: <title>"').setMaxLength(100))
      .addStringOption((o) => o.setName("notes").setDescription("Notes shown on the RSVP card").setMaxLength(1000)),
  )
  .addSubcommand((s) =>
    s
      .setName("edit")
      .setDescription("Change a scheduled session (DMs/admins)")
      .addStringOption((o) => o.setName("session").setDescription("Session").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("campaign").setDescription("Move it to this campaign").setAutocomplete(true))
      .addStringOption((o) => o.setName("title").setDescription('New title ("-" to clear)').setMaxLength(100))
      .addStringOption((o) => o.setName("date").setDescription("New date (YYYY-MM-DD)"))
      .addStringOption((o) => o.setName("time").setDescription("New start time, e.g. 18:00"))
      .addStringOption((o) => o.setName("notes").setDescription('New notes ("-" to clear)').setMaxLength(1000)),
  )
  .addSubcommand((s) =>
    s
      .setName("cancel")
      .setDescription("Cancel a scheduled session (DMs/admins)")
      .addStringOption((o) => o.setName("session").setDescription("Session").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("reason").setDescription("Shown on the session card").setMaxLength(300)),
  )
  .addSubcommand((s) =>
    s
      .setName("list")
      .setDescription("List upcoming sessions")
      .addStringOption((o) => o.setName("campaign").setDescription("Campaign").setAutocomplete(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("responses")
      .setDescription("See who has and hasn't responded (DMs/admins)")
      .addStringOption((o) => o.setName("session").setDescription("Session").setRequired(true).setAutocomplete(true)),
  );

function sessionIdOption(i: ChatInputCommandInteraction<"cached">): number {
  const raw = i.options.getString("session", true);
  if (!/^\d+$/.test(raw)) throw new UserError("Pick a session from the suggestions.");
  return Number(raw);
}

type Handler = (i: ChatInputCommandInteraction<"cached">, ctx: AppContext) => Promise<void>;

const handlers: Record<string, Handler> = {
  async add(i, ctx) {
    const actor = actorFrom(i);
    const settings = await requireGuildSettings(ctx.db, i.guildId);
    const month = parseMonthOption(i, settings.timezone, ctx.now());
    const campaignId = i.options.getString("campaign") ? await resolveCampaignId(i, ctx) : 0;
    await replyPrivateCalendar(i, await privateCalendarView(ctx, actor, { mode: "add", month, campaignId, mask: 0 }));
  },

  async create(i, ctx) {
    const campaignId = await resolveCampaignId(i, ctx);
    await i.deferReply(ephemeral);
    const { session, campaign } = await createSession(
      ctx.db,
      actorFrom(i),
      campaignId,
      {
        title: i.options.getString("title"),
        date: i.options.getString("date", true),
        time: i.options.getString("time"),
        notes: i.options.getString("notes"),
      },
      ctx.now(),
    );
    await afterSessionsCreated(ctx, campaign.guildId, [session]);
    await i.editReply(
      `✅ Scheduled ${colorEmoji(campaign.color)} **${sessionHeading(campaign, session)}** — ${formatSessionTime(session.startsAt, campaign.timezone)}.`,
    );
  },

  async edit(i, ctx) {
    const notes = i.options.getString("notes");
    const title = i.options.getString("title");
    const moveTo = i.options.getString("campaign") ? await resolveCampaignId(i, ctx) : null;
    await i.deferReply(ephemeral);
    const { session, campaign, timeChanged, moved } = await editSession(
      ctx.db,
      actorFrom(i),
      sessionIdOption(i),
      {
        campaignId: moveTo,
        title: title === "-" ? "" : title,
        date: i.options.getString("date"),
        time: i.options.getString("time"),
        notes: notes === "-" ? "" : notes,
      },
      ctx.now(),
    );
    await afterSessionEdited(ctx, campaign, session, timeChanged);
    await i.editReply(
      `✅ Updated ${colorEmoji(campaign.color)} **${sessionHeading(campaign, session)}** — ${formatSessionTime(session.startsAt, campaign.timezone)}.` +
        (moved ? ` Moved to **${campaign.name}**.` : ""),
    );
  },

  async cancel(i, ctx) {
    await i.deferReply(ephemeral);
    const { session, campaign } = await cancelSession(ctx.db, actorFrom(i), sessionIdOption(i), i.options.getString("reason"));
    await afterSessionCancelled(ctx, campaign, session);
    await i.editReply(`✅ Cancelled **${sessionHeading(campaign, session)}**.`);
  },

  async list(i, ctx) {
    const actor = actorFrom(i);
    const campaignId = await resolveCampaignId(i, ctx);
    const { campaign } = await authorize(ctx.db, actor, campaignId, "campaign.view");
    const upcoming = (await listUpcomingForActor(ctx.db, actor, "campaign.view", ctx.now())).filter(
      (s) => s.campaign.id === campaign.id,
    );
    const lines = upcoming.map(({ session }) => {
      const url = cardUrlOf(campaign, session);
      const label = url ? `[${sessionLabel(session)}](${url})` : sessionLabel(session);
      return `• ${label} — ${formatSessionTime(session.startsAt, campaign.timezone)} · ${discordTimestamp(session.startsAt, "t")} your time`;
    });
    await i.reply({
      ...ephemeral,
      content: `**Upcoming sessions — ${campaign.name}**\n${lines.join("\n") || "*Nothing scheduled.*"}`,
    });
  },

  async responses(i, ctx) {
    const { session } = await loadSession(ctx.db, actorFrom(i), sessionIdOption(i), "session.viewResponses");
    const overview = (await getSessionOverview(ctx.db, session.id))!;
    const remind = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeCustomId({ kind: "ss.remind", sessionId: session.id }))
        .setLabel("Remind non-responders now")
        .setEmoji("🔔")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(session.status !== "scheduled" || !overview.groups.noResponse.length),
    );
    await i.reply({ ...ephemeral, embeds: [renderResponses(overview)], components: [remind] });
  },
};

const AUTOCOMPLETE_ACTIONS: Record<string, Action> = {
  add: "session.create",
  create: "session.create",
  edit: "session.edit",
  cancel: "session.cancel",
  list: "campaign.view",
  responses: "session.viewResponses",
};

export const sessionCommand: SlashCommand = {
  name: data.name,
  toJSON: () => data.toJSON(),
  async execute(i, ctx) {
    const handler = handlers[i.options.getSubcommand()];
    if (!handler) throw new UserError("Unknown subcommand.");
    await handler(i, ctx);
  },
  async autocomplete(i, ctx) {
    const focused = i.options.getFocused(true);
    const action = AUTOCOMPLETE_ACTIONS[i.options.getSubcommand()] ?? "campaign.view";
    if (focused.name === "date") return i.respond(await autocompleteDate(i, ctx));
    if (focused.name === "session") return i.respond(await autocompleteSession(i, ctx, action));
    // Moving a session needs the right to schedule in the target campaign.
    if (i.options.getSubcommand() === "edit") return i.respond(await autocompleteCampaign(i, ctx, "session.create"));
    await i.respond(await autocompleteCampaign(i, ctx, action));
  },
};
