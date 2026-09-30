import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ApplicationCommandOptionChoiceData,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
} from "discord.js";
import { describeDayAvailability } from "../../domain/availability.js";
import { PALETTE } from "../../domain/color.js";
import { UserError } from "../../domain/errors.js";
import { can, type Action } from "../../domain/permissions.js";
import {
  addDays,
  currentMonthIn,
  dateRange,
  FIXED_OFFSET_TIMEZONES,
  formatDayShort,
  localDateOf,
  localTimeOf,
  offsetLabel,
  parseLocalDate,
  parseYearMonth,
  REGION_TIMEZONES,
  todayIn,
} from "../../domain/time.js";
import type { Campaign, YearMonth } from "../../domain/types.js";
import { summarizeCampaignDates } from "../../services/availabilityService.js";
import { listVisibleCampaigns } from "../../services/campaignService.js";
import { listUpcomingForActor } from "../../services/sessionService.js";
import { truncate } from "../render/format.js";
import { sessionLabel } from "../render/rsvpCard.js";
import type { AppContext } from "../context.js";
import { actorFrom } from "../context.js";

export const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

export const ephemeral = { flags: MessageFlags.Ephemeral } as const;

/**
 * Resolves the optional `campaign` option: an autocomplete ID, a typed name,
 * or — when omitted — the only campaign the user can see.
 */
export async function resolveCampaignId(
  interaction: ChatInputCommandInteraction<"cached"> | AutocompleteInteraction<"cached">,
  ctx: AppContext,
  optionName = "campaign",
): Promise<number> {
  const raw = interaction.options.getString(optionName)?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  const visible = await listVisibleCampaigns(ctx.db, actorFrom(interaction));
  if (raw) {
    const match = visible.find((c) => c.campaign.name.toLowerCase() === raw.toLowerCase());
    if (!match) throw new UserError(`No campaign called "${raw}" that you can access.`);
    return match.campaign.id;
  }
  if (visible.length === 1) return visible[0]!.campaign.id;
  if (!visible.length) throw new UserError("You're not in any campaigns on this server yet. Ask a DM to add you.");
  throw new UserError("You're in several campaigns — pick one with the `campaign` option.");
}

export function parseMonthOption(interaction: ChatInputCommandInteraction<"cached">, timezone: string, now: Date): YearMonth {
  const raw = interaction.options.getString("month");
  return raw ? parseYearMonth(raw) : currentMonthIn(timezone, now);
}

export async function autocompleteCampaign(
  interaction: AutocompleteInteraction<"cached">,
  ctx: AppContext,
  action: Action,
): Promise<ApplicationCommandOptionChoiceData[]> {
  const actor = actorFrom(interaction);
  const query = interaction.options.getFocused().toLowerCase();
  return (await listVisibleCampaigns(ctx.db, actor))
    .filter((c) => can(actor, c.role, action) && c.campaign.name.toLowerCase().includes(query))
    .slice(0, 25)
    .map((c) => ({ name: truncate(c.campaign.name, 100), value: String(c.campaign.id) }));
}

export async function autocompleteSession(
  interaction: AutocompleteInteraction<"cached">,
  ctx: AppContext,
  action: Action,
): Promise<ApplicationCommandOptionChoiceData[]> {
  const query = interaction.options.getFocused().toLowerCase();
  const upcoming = await listUpcomingForActor(ctx.db, actorFrom(interaction), action, ctx.now());
  return upcoming
    .map(({ session, campaign }) => ({
      name: truncate(
        `${campaign.name} — ${sessionLabel(session)} · ${formatDayShort(localDateOf(session.startsAt, campaign.timezone))} ${localTimeOf(session.startsAt, campaign.timezone)}`,
        100,
      ),
      value: String(session.id),
    }))
    .filter((c) => c.name.toLowerCase().includes(query))
    .slice(0, 25);
}

/** Palette names (with a hex hint); a typed hex code is offered as-is. */
export function autocompleteColor(query: string): ApplicationCommandOptionChoiceData[] {
  const q = query.trim().toLowerCase();
  const named = (Object.entries(PALETTE) as [string, string][])
    .filter(([name, hex]) => name.includes(q) || hex.includes(q))
    .map(([name, hex]) => ({ name: `${name} (${hex})`, value: name }));
  const hex = /^#?[0-9a-f]{6}$/.test(q) ? [{ name: `Custom ${q.startsWith("#") ? q : `#${q}`}`, value: q }] : [];
  return [...hex, ...named].slice(0, 25);
}

/**
 * Region names with the offset in effect now ("Central European Time (UTC+2 now)"),
 * then whole-hour offsets. Typing "+2" finds both kinds.
 */
export function autocompleteTimezone(query: string, now: Date = new Date()): ApplicationCommandOptionChoiceData[] {
  const q = query.trim().toLowerCase().replace(/^(utc|gmt)\s*/, "").replace(/\s+/g, " ");
  const regions = REGION_TIMEZONES.map((r) => {
    const offset = offsetLabel(now, r.zone);
    return { name: `${r.name} (${offset} now)`, value: r.name, match: [r.name.toLowerCase(), offset.toLowerCase()] };
  });
  const offsets = FIXED_OFFSET_TIMEZONES.map((tz) => ({ name: tz, value: tz, match: [tz.toLowerCase()] }));
  const matches = (m: string[]) => !q || m.some((text) => text.includes(q) || text === `utc${q}`);
  // "+2" should find UTC+2 but not UTC+12.
  const exact = (m: string[]) => !/^[+-]\d+$/.test(q) || m.some((text) => text.endsWith(q));
  return [...regions, ...offsets]
    .filter((c) => matches(c.match) && exact(c.match))
    .slice(0, 25)
    .map(({ name, value }) => ({ name, value }));
}

/** Date suggestions with availability, e.g. "Fri 16 Oct — 3/5 available". */
export async function autocompleteDate(
  interaction: AutocompleteInteraction<"cached">,
  ctx: AppContext,
): Promise<ApplicationCommandOptionChoiceData[]> {
  const typed = interaction.options.getFocused().trim();
  const actor = actorFrom(interaction);
  let campaign: Campaign | null = null;
  try {
    const id = await resolveCampaignId(interaction, ctx);
    const visible = await listVisibleCampaigns(ctx.db, actor);
    campaign = visible.find((c) => c.campaign.id === id && can(actor, c.role, "session.create"))?.campaign ?? null;
  } catch {
    // Campaign not chosen yet: suggest plain dates.
  }
  const tz = campaign?.timezone ?? "UTC";
  let from = todayIn(tz, ctx.now());
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(typed)) from = parseLocalDate(typed);
  } catch {
    // Keep suggesting from today while the user is still typing.
  }
  if (!campaign) {
    return Array.from({ length: 25 }, (_, i) => addDays(from, i)).map((d) => ({ name: `${formatDayShort(d)} (${d})`, value: d }));
  }
  const summary = await summarizeCampaignDates(ctx.db, campaign, dateRange(from, 25));
  return [...summary.values()]
    .map((day) => ({ name: truncate(`${formatDayShort(day.date)} — ${describeDayAvailability(day)}`, 100), value: day.date }))
    .filter((c) => !typed || /^\d{4}-\d{2}-\d{2}$/.test(typed) || c.name.toLowerCase().includes(typed.toLowerCase()));
}

/** Ensures the bot can post and embed in a channel before a campaign starts using it. */
export function assertBotCanPost(channel: GuildBasedChannel): void {
  const me = channel.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  const needed = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  if (!perms || !needed.every((p) => perms.has(p))) {
    throw new UserError(`I need View Channel, Send Messages, Embed Links and Read Message History in <#${channel.id}>.`);
  }
}

