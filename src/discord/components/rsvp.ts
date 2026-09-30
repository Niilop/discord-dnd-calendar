import type { ButtonInteraction } from "discord.js";
import { respondToSession } from "../../services/rsvpService.js";
import { actorFrom, type AppContext } from "../context.js";
import type { CustomId } from "../customIds.js";

/**
 * RSVP buttons live on the session card. The response is stored for the
 * clicking user and the card is re-rendered from the database; the card
 * itself is the confirmation, so there is no private reply. Errors (e.g. the
 * session was cancelled) still get one through the router.
 */
export async function handleRsvp(
  i: ButtonInteraction<"cached">,
  id: Extract<CustomId, { kind: "rsvp" }>,
  ctx: AppContext,
): Promise<void> {
  const { session, campaign, previous } = await respondToSession(ctx.db, actorFrom(i), id.sessionId, id.status, ctx.now());
  await i.deferUpdate();
  if (previous !== id.status) {
    await ctx.publisher.syncSessionCard(session.id, { refresh: true });
    ctx.publisher.scheduleCalendarRefresh(campaign.guildId);
  }
}
