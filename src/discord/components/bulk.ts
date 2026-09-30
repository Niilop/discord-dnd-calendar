import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";
import { UserError } from "../../domain/errors.js";
import { formatDayShort, localDatesToUtcRange, offsetLabel, parseLocalTime, todayIn } from "../../domain/time.js";
import { authorize } from "../../services/access.js";
import { createSessions, usualTime } from "../../services/sessionService.js";
import { actorFrom, type AppContext } from "../context.js";
import type { BulkState } from "../customIds.js";
import { BULK_MODAL_FIELDS, renderBulkCreateModal } from "../render/bulkPanel.js";
import { asEdit } from "../render/calendar.js";
import { datesInMask } from "../render/dayMenu.js";
import { afterSessionsCreated } from "../sessionEffects.js";
import { privateCalendarView } from "../views.js";

const stateOf = ({ campaignId, month, mask }: BulkState): BulkState => ({ campaignId, month, mask });

/** Create (in the calendar's Add sessions mode) asks for the start time, prefilled with what the campaign used last. */
export async function handleBulkGo(i: ButtonInteraction<"cached">, id: BulkState, ctx: AppContext) {
  const { campaign } = await authorize(ctx.db, actorFrom(i, ctx), id.campaignId, "session.create");
  const today = todayIn(campaign.timezone, ctx.now());
  const days = datesInMask(id.month, id.mask).filter((d) => d >= today);
  if (!days.length) throw new UserError("Pick at least one day in the menu first.");
  const offset = offsetLabel(localDatesToUtcRange(days[0]!, days[0]!, campaign.timezone).start, campaign.timezone);
  await i.showModal(renderBulkCreateModal(stateOf(id), campaign.name, days.length, offset, await usualTime(ctx.db, campaign)));
}

/** Creates every picked session in one transaction, then redraws the calendar with them on it. */
export async function handleBulkCreate(i: ModalSubmitInteraction<"cached">, id: BulkState, ctx: AppContext) {
  if (!i.isFromMessage()) throw new UserError("This form has expired. Open Add sessions again.");
  const actor = actorFrom(i, ctx);
  const { hour, minute } = parseLocalTime(i.fields.getTextInputValue(BULK_MODAL_FIELDS.time));
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const dates = datesInMask(id.month, id.mask);

  // Create before deferring so a rejection (e.g. a day already past that time) is shown as a normal reply.
  const { sessions, campaign } = await createSessions(ctx.db, actor, id.campaignId, { dates, time }, ctx.now());
  await i.deferUpdate();
  await afterSessionsCreated(ctx, campaign.guildId, sessions);
  const notice = `✅ Created ${sessions.length} session${sessions.length === 1 ? "" : "s"} at ${time}: ${dates.map(formatDayShort).join(", ")}`;
  const state = { mode: "add", month: id.month, campaignId: campaign.id, mask: 0 } as const;
  await i.editReply(asEdit(await privateCalendarView(ctx, actor, state, notice)));
}
