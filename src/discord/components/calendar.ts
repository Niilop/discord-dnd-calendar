import { MessageFlags, type ButtonInteraction, type StringSelectMenuInteraction } from "discord.js";
import { UserError } from "../../domain/errors.js";
import { formatDayShort, todayIn } from "../../domain/time.js";
import type { AvailabilityValue } from "../../domain/types.js";
import { setOwnAvailability } from "../../services/availabilityService.js";
import { requireGuildSettings } from "../../services/guildService.js";
import { actorFrom, type AppContext } from "../context.js";
import type { CalendarState, CustomId } from "../customIds.js";
import { replyPrivateCalendar } from "../privateCalendar.js";
import { asEdit } from "../render/calendar.js";
import { applyPick, datesInMask } from "../render/dayMenu.js";
import { privateCalendarView, sessionCalendarView } from "../views.js";

type Of<K extends CustomId["kind"]> = Extract<CustomId, { kind: K }>;

const stateOf = ({ mode, month, campaignId, mask, sessionId }: CalendarState): CalendarState => ({ mode, month, campaignId, mask, sessionId });

/**
 * Month and mode buttons. The shared calendar always shows the current month
 * for everyone, so its buttons open a private copy; inside that copy they
 * redraw it in place. Opening a new copy removes the person's previous one.
 */
export async function handleCalendar(i: ButtonInteraction<"cached">, id: Of<"cv">, ctx: AppContext): Promise<void> {
  const view = await privateCalendarView(ctx, actorFrom(i, ctx), stateOf(id));
  if (i.message.flags.has(MessageFlags.Ephemeral)) await i.update(asEdit(view));
  else await replyPrivateCalendar(i, view);
}

/** Picking days in the day menu only selects them (green on the calendar); nothing is saved yet. */
export async function handleCalendarPick(i: StringSelectMenuInteraction<"cached">, id: Of<"cv.pick">, ctx: AppContext): Promise<void> {
  const mask = applyPick(id.mask, id.from, id.to, i.values.map(Number));
  await i.update(asEdit(await privateCalendarView(ctx, actorFrom(i, ctx), { ...stateOf(id), mask })));
}

/** Add sessions: switching campaign keeps the picked days. */
export async function handleCalendarCampaign(i: StringSelectMenuInteraction<"cached">, id: Of<"cv.camp">, ctx: AppContext): Promise<void> {
  const campaignId = Number(i.values[0]);
  if (!Number.isInteger(campaignId)) throw new UserError("Pick a campaign from the menu.");
  await i.update(asEdit(await privateCalendarView(ctx, actorFrom(i, ctx), { mode: "add", month: id.month, campaignId, mask: id.mask })));
}

const MARKED_AS: Record<AvailabilityValue, string> = {
  unavailable: "🚫 can't play",
  prefer_not: "❔ unsure",
  unspecified: "cleared",
};

/** Can't play / Unsure / Clear: saves the picked days (today onwards) and clears the pick. */
export async function handleCalendarMark(i: ButtonInteraction<"cached">, id: Of<"cv.mark">, ctx: AppContext): Promise<void> {
  const actor = actorFrom(i, ctx);
  const settings = await requireGuildSettings(ctx.db, actor.guildId);
  const today = todayIn(settings.timezone, ctx.now());
  const dates = datesInMask(id.month, id.mask).filter((d) => d >= today);
  if (!dates.length) throw new UserError("Pick at least one day in the menu first.");
  await setOwnAvailability(ctx.db, actor, dates, id.status);
  const notice = `✅ ${dates.map(formatDayShort).join(", ")}: **${MARKED_AS[id.status]}**`;
  await i.update(asEdit(await privateCalendarView(ctx, actor, { mode: "avail", month: id.month, campaignId: 0, mask: 0 }, notice)));
  ctx.publisher.scheduleCalendarRefresh(i.guildId);
}

/** Edit sessions: picking a session shows its controls under the calendar, in the month it's in. */
export async function handleCalendarEdit(i: StringSelectMenuInteraction<"cached">, ctx: AppContext): Promise<void> {
  const sessionId = Number(i.values[0]);
  if (!Number.isInteger(sessionId)) throw new UserError("Pick a session from the menu.");
  await i.update(asEdit(await sessionCalendarView(ctx, actorFrom(i, ctx), sessionId)));
}
