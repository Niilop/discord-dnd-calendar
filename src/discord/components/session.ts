import { MessageFlags, type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction } from "discord.js";
import { colorEmoji } from "../../domain/color.js";
import { UserError } from "../../domain/errors.js";
import { formatSessionTime } from "../../domain/time.js";
import { cancelSession, editSession, getSessionOverview, loadSession } from "../../services/sessionService.js";
import { actorFrom, type AppContext } from "../context.js";
import { asEdit } from "../render/calendar.js";
import { renderSessionTimeModal, SESSION_MODAL_FIELDS } from "../render/sessionPanel.js";
import { afterSessionCancelled, afterSessionEdited } from "../sessionEffects.js";
import { sessionCalendarView } from "../views.js";

type SessionRef = { sessionId: number };

export async function handleSessionView(i: ButtonInteraction<"cached">, id: SessionRef, ctx: AppContext) {
  await i.update(asEdit(await sessionCalendarView(ctx, actorFrom(i), id.sessionId)));
}

/** Moves the session to another campaign: its color on the calendar changes with it. */
export async function handleSessionCampaign(i: StringSelectMenuInteraction<"cached">, id: SessionRef, ctx: AppContext) {
  const actor = actorFrom(i);
  const target = Number(i.values[0]);
  const result = await editSession(ctx.db, actor, id.sessionId, { campaignId: target }, ctx.now());
  await afterSessionEdited(ctx, result.campaign, result.session, false);
  const notice = result.moved
    ? `✅ Moved from ${colorEmoji(result.previousCampaign.color)} ${result.previousCampaign.name} to ${colorEmoji(result.campaign.color)} **${result.campaign.name}**.`
    : undefined;
  await i.update(asEdit(await sessionCalendarView(ctx, actor, id.sessionId, notice ? { notice } : {})));
}

export async function handleSessionTime(i: ButtonInteraction<"cached">, id: SessionRef, ctx: AppContext) {
  await loadSession(ctx.db, actorFrom(i), id.sessionId, "session.edit");
  const overview = await getSessionOverview(ctx.db, id.sessionId);
  if (!overview) throw new UserError("That session doesn't exist anymore.");
  await i.showModal(renderSessionTimeModal(overview));
}

export async function handleSessionTimeSet(i: ModalSubmitInteraction<"cached">, id: SessionRef, ctx: AppContext) {
  if (!i.isFromMessage()) throw new UserError("This form has expired. Open the session again.");
  const actor = actorFrom(i);
  const field = (name: string) => i.fields.getTextInputValue(name).trim();
  const result = await editSession(
    ctx.db,
    actor,
    id.sessionId,
    {
      date: field(SESSION_MODAL_FIELDS.date),
      time: field(SESSION_MODAL_FIELDS.time),
      title: field(SESSION_MODAL_FIELDS.title),
    },
    ctx.now(),
  );
  await i.deferUpdate();
  await afterSessionEdited(ctx, result.campaign, result.session, result.timeChanged);
  const when = formatSessionTime(result.session.startsAt, result.campaign.timezone);
  const notice = result.timeChanged ? `✅ Moved to **${when}**.` : "✅ Saved.";
  await i.editReply(asEdit(await sessionCalendarView(ctx, actor, id.sessionId, { notice })));
}

export async function handleSessionCancel(i: ButtonInteraction<"cached">, id: SessionRef, ctx: AppContext) {
  await i.update(asEdit(await sessionCalendarView(ctx, actorFrom(i), id.sessionId, { confirmingCancel: true })));
}

export async function handleSessionConfirmCancel(i: ButtonInteraction<"cached">, id: SessionRef, ctx: AppContext) {
  const actor = actorFrom(i);
  const { session, campaign } = await cancelSession(ctx.db, actor, id.sessionId);
  await i.deferUpdate();
  await afterSessionCancelled(ctx, campaign, session);
  await i.editReply(asEdit(await sessionCalendarView(ctx, actor, id.sessionId, { notice: "❌ Session cancelled." })));
}

/** "Remind non-responders now" from /session responses. */
export async function handleRemindNow(i: ButtonInteraction<"cached">, id: SessionRef, ctx: AppContext) {
  const { session, campaign } = await loadSession(ctx.db, actorFrom(i), id.sessionId, "session.edit");
  if (session.status !== "scheduled" || session.startsAt <= ctx.now()) throw new UserError("This session is no longer upcoming.");
  if (!campaign.rsvpChannelId) throw new UserError("This campaign has no reminder channel. Set one with `/campaign edit reminder_channel`.");
  await i.deferUpdate();
  try {
    const sent = await ctx.publisher.syncSessionCard(session.id, { remind: true });
    await i.followUp({ flags: MessageFlags.Ephemeral, content: `🔔 Session card reposted; pinged ${sent.pinged} member(s).` });
  } catch (error) {
    ctx.log.warn({ err: error, sessionId: session.id }, "manual reminder failed");
    throw new UserError("I couldn't post the reminder. Check my permissions in the reminder channel.");
  }
}
