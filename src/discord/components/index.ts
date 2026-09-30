import {
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { UserError } from "../../domain/errors.js";
import type { AppContext } from "../context.js";
import { parseCustomId, type CustomId } from "../customIds.js";
import { touchPrivateCalendar } from "../privateCalendar.js";
import { handleBulkCreate, handleBulkGo } from "./bulk.js";
import { handleCalendar, handleCalendarCampaign, handleCalendarEdit, handleCalendarMark, handleCalendarPick } from "./calendar.js";
import { handleRsvp } from "./rsvp.js";
import {
  handleRemindNow,
  handleSessionCampaign,
  handleSessionCancel,
  handleSessionConfirmCancel,
  handleSessionTime,
  handleSessionTimeSet,
  handleSessionView,
} from "./session.js";

const STALE = "This control is from an older version of the bot. Open a fresh one from the calendar or with `/calendar show`.";

/** Components that live on a private calendar and redraw it (not the ones that open a form). */
const ON_PRIVATE_CALENDAR = new Set<CustomId["kind"]>([
  "cv",
  "cv.pick",
  "cv.mark",
  "cv.camp",
  "cv.edit",
  "bk.create",
  "se.view",
  "se.camp",
  "se.timeset",
  "se.cancel",
  "se.confirm",
]);

export async function handleComponent(i: Interaction<"cached">, ctx: AppContext): Promise<void> {
  if (!i.isButton() && !i.isStringSelectMenu() && !i.isModalSubmit()) return;
  const id = parseCustomId(i.customId);
  if (!id) throw new UserError(STALE);
  await dispatch(i, id, ctx);
  if (ON_PRIVATE_CALENDAR.has(id.kind) && i.message?.flags.has(MessageFlags.Ephemeral)) touchPrivateCalendar(i);
}

/** Dispatches buttons, selects and modals by their parsed custom ID and component type. */
async function dispatch(
  i: ButtonInteraction<"cached"> | StringSelectMenuInteraction<"cached"> | ModalSubmitInteraction<"cached">,
  id: CustomId,
  ctx: AppContext,
): Promise<void> {

  if (i.isButton()) {
    switch (id.kind) {
      case "cv":
        return handleCalendar(i, id, ctx);
      case "cv.mark":
        return handleCalendarMark(i, id, ctx);
      case "bk.go":
        return handleBulkGo(i, id, ctx);
      case "se.view":
        return handleSessionView(i, id, ctx);
      case "se.time":
        return handleSessionTime(i, id, ctx);
      case "se.cancel":
        return handleSessionCancel(i, id, ctx);
      case "se.confirm":
        return handleSessionConfirmCancel(i, id, ctx);
      case "rsvp":
        return handleRsvp(i, id, ctx);
      case "ss.remind":
        return handleRemindNow(i, id, ctx);
      default:
        break;
    }
  } else if (i.isStringSelectMenu()) {
    switch (id.kind) {
      case "cv.pick":
        return handleCalendarPick(i, id, ctx);
      case "cv.camp":
        return handleCalendarCampaign(i, id, ctx);
      case "cv.edit":
        return handleCalendarEdit(i, ctx);
      case "se.camp":
        return handleSessionCampaign(i, id, ctx);
      default:
        break;
    }
  } else {
    switch (id.kind) {
      case "bk.create":
        return handleBulkCreate(i, id, ctx);
      case "se.timeset":
        return handleSessionTimeSet(i, id, ctx);
      default:
        break;
    }
  }
  throw new UserError(STALE);
}
