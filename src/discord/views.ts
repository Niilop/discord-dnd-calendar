import { PermissionDeniedError } from "../domain/errors.js";
import { can, type Actor } from "../domain/permissions.js";
import { localDateOf } from "../domain/time.js";
import type { Campaign } from "../domain/types.js";
import { getOwnAvailability, summarizeCampaignDates } from "../services/availabilityService.js";
import { buildMonthView } from "../services/calendarService.js";
import { listVisibleCampaigns } from "../services/campaignService.js";
import { requireGuildSettings } from "../services/guildService.js";
import { getSessionOverview, loadSession } from "../services/sessionService.js";
import type { AppContext } from "./context.js";
import type { CalendarState } from "./customIds.js";
import { renderCalendarMessage, type CalendarPanel, type V2Payload } from "./render/calendar.js";

/** Views shared by slash commands and component handlers. Each one authorizes. */

/** Campaigns the actor may schedule sessions for. */
export async function schedulableCampaigns(ctx: AppContext, actor: Actor): Promise<Campaign[]> {
  return (await listVisibleCampaigns(ctx.db, actor)).filter((c) => can(actor, c.role, "session.create")).map((c) => c.campaign);
}

/**
 * Someone's private copy of the calendar: any month, plus the panel for the
 * mode they're in (marking days, adding sessions, editing sessions).
 */
export async function privateCalendarView(
  ctx: AppContext,
  actor: Actor,
  state: Omit<CalendarState, "sessionId"> & { sessionId?: number },
  notice?: string,
  opts: { confirmingCancel?: boolean } = {},
): Promise<V2Payload> {
  const settings = await requireGuildSettings(ctx.db, actor.guildId);
  const view = await buildMonthView(ctx.db, settings, state.month, ctx.now());
  const first = view.days[0]!;
  const last = view.days.at(-1)!;

  let panel: CalendarPanel | undefined;
  switch (state.mode) {
    case "avail":
      panel = { mode: "avail", marks: (await getOwnAvailability(ctx.db, actor, first, last)).statuses };
      break;
    case "add": {
      const campaigns = await schedulableCampaigns(ctx, actor);
      const campaign = campaigns.find((c) => c.id === state.campaignId) ?? campaigns[0];
      if (!campaign) throw new PermissionDeniedError("Only campaign DMs/admins can add sessions.");
      panel = { mode: "add", campaigns, campaign, availability: await summarizeCampaignDates(ctx.db, campaign, view.days) };
      break;
    }
    case "edit": {
      const editable = new Set(
        (await listVisibleCampaigns(ctx.db, actor)).filter((c) => can(actor, c.role, "session.edit")).map((c) => c.campaign.id),
      );
      if (!editable.size) throw new PermissionDeniedError("Only campaign DMs/admins can edit sessions.");
      const now = ctx.now();
      const sessions = view.sessions.filter(
        (s) => s.session.status === "scheduled" && s.session.endsAt > now && editable.has(s.campaign.id),
      );
      panel = { mode: "edit", sessions };
      const selected = state.sessionId ? sessions.find((s) => s.session.id === state.sessionId) : undefined;
      if (selected) {
        await loadSession(ctx.db, actor, selected.session.id, "session.edit");
        const [overview, campaigns] = await Promise.all([getSessionOverview(ctx.db, selected.session.id), schedulableCampaigns(ctx, actor)]);
        if (overview) panel.selected = { overview, campaigns, ...(notice ? { notice } : {}), ...opts };
      }
      break;
    }
    case "view":
      break;
  }
  // With a session picked, the notice shows next to it instead of under the heading.
  const panelNotice = notice && !(panel?.mode === "edit" && panel.selected) ? { notice } : {};
  return renderCalendarMessage(view, { mask: state.mask, ...(panel ? { panel } : {}), ...panelNotice });
}

/**
 * Edit sessions with `sessionId` picked, in the month it's in. A session that
 * can't be edited any more (cancelled, over) just leaves the month's list.
 */
export async function sessionCalendarView(
  ctx: AppContext,
  actor: Actor,
  sessionId: number,
  opts: { notice?: string; confirmingCancel?: boolean } = {},
): Promise<V2Payload> {
  const { session, campaign } = await loadSession(ctx.db, actor, sessionId, "session.edit");
  const month = localDateOf(session.startsAt, campaign.timezone).slice(0, 7);
  const state = { mode: "edit", month, campaignId: 0, mask: 0, sessionId } as const;
  return privateCalendarView(ctx, actor, state, opts.notice, opts.confirmingCancel ? { confirmingCancel: true } : {});
}
