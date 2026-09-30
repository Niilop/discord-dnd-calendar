import {
  DiscordAPIError,
  RESTJSONErrorCodes,
  type Client,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  type SendableChannels,
} from "discord.js";
import type { Db } from "../db/db.js";
import { findGuildSettings, setGuildCalendarMessage } from "../db/repositories/guildSettings.js";
import { listGuildCardSessionIds, setSessionCard } from "../db/repositories/sessions.js";
import { cardPings, desiredCard, planCardSync } from "../domain/reminders.js";
import { currentMonthIn } from "../domain/time.js";
import type { Logger } from "../logger.js";
import { buildMonthView } from "../services/calendarService.js";
import { getSessionOverview } from "../services/sessionService.js";
import { asEdit, CALENDAR_LAYOUT, renderCalendarMessage } from "./render/calendar.js";
import { renderSessionCard } from "./render/rsvpCard.js";

const CALENDAR_DEBOUNCE_MS = 2_000;

export interface CardSyncOptions {
  /** The session was rescheduled or cancelled: repost the card so the change is noticed. */
  announce?: boolean;
  /** Its details or RSVPs changed: edit the card in place. */
  refresh?: boolean;
  /** "Remind now": post the card even before the window opens and ping non-responders. */
  remind?: boolean;
}

const GONE_CODES: ReadonlySet<number> = new Set([RESTJSONErrorCodes.UnknownMessage, RESTJSONErrorCodes.UnknownChannel]);
const FORBIDDEN_CODES: ReadonlySet<number> = new Set([RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions]);

const isDiscordError = (e: unknown, codes: ReadonlySet<number>): boolean =>
  e instanceof DiscordAPIError && typeof e.code === "number" && codes.has(e.code);

/**
 * Owns every message the bot keeps up to date: the server calendar and the
 * session cards in reminder channels.
 *
 * - Content is always re-rendered from the database, never patched, so
 *   updates are idempotent and self-healing.
 * - Work is serialized per message key, so concurrent clicks can't make an
 *   older render overwrite a newer one.
 * - A deleted calendar message is re-posted; permission problems are logged
 *   and retried by the scheduler with back-off. Transient HTTP errors and
 *   rate limits are retried by discord.js's REST client.
 */
export class Publisher {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly calendarTimers = new Map<string, NodeJS.Timeout>();
  /** Guilds whose last calendar refresh failed; the scheduler retries them. */
  readonly staleCalendars = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Refresh the server calendar soon, coalescing bursts of changes (e.g. availability clicks). */
  scheduleCalendarRefresh(guildId: string): void {
    clearTimeout(this.calendarTimers.get(guildId));
    this.calendarTimers.set(
      guildId,
      setTimeout(() => {
        this.calendarTimers.delete(guildId);
        void this.refreshCalendar(guildId);
      }, CALENDAR_DEBOUNCE_MS),
    );
  }

  /** Edits (or posts) the server's calendar message for the current month. */
  refreshCalendar(guildId: string): Promise<void> {
    return this.serialize(`calendar:${guildId}`, async () => {
      try {
        const settings = await findGuildSettings(this.db, guildId);
        if (!settings) return;
        const month = currentMonthIn(settings.timezone);
        const payload = renderCalendarMessage(await buildMonthView(this.db, settings, month));
        const channel = await this.sendableChannel(guildId, settings.calendarChannelId);

        // A message in an older layout or another channel can't be reused: post fresh, delete the old one.
        let message: Message | null = null;
        if (
          settings.calendarMessageId &&
          settings.calendarMessageChannelId === settings.calendarChannelId &&
          settings.calendarMessageLayout === CALENDAR_LAYOUT
        ) {
          message = await this.editOrNull(channel, settings.calendarMessageId, asEdit(payload));
        }
        if (!message) {
          message = await channel.send(payload satisfies MessageCreateOptions);
          await this.deleteQuietly(settings.calendarMessageChannelId, settings.calendarMessageId);
        }
        await setGuildCalendarMessage(this.db, guildId, {
          channelId: message.channelId,
          messageId: message.id,
          month,
          layout: CALENDAR_LAYOUT,
        });
        this.staleCalendars.delete(guildId);
      } catch (error) {
        this.staleCalendars.add(guildId);
        this.log.warn({ err: error, guildId }, "calendar refresh failed");
      }
    });
  }

  /**
   * Makes a session's card in the reminder channel match the database (see
   * domain/reminders.ts): posts it once the reminder window opens, reposts it
   * when the session moves or is cancelled, edits it on `refresh`, and
   * deletes it once its day is over.
   *
   * Failures are logged and fixed by the next scheduler tick, except with
   * `remind` (the DMs' "remind now" button), which throws so the DM hears about it.
   * Returns how many members were pinged.
   */
  syncSessionCard(sessionId: number, opts: CardSyncOptions = {}): Promise<{ pinged: number }> {
    return this.serialize(`session:${sessionId}`, async () => {
      try {
        return await this.syncCard(sessionId, opts);
      } catch (error) {
        if (opts.remind) throw error;
        this.log.warn({ err: error, sessionId }, "session card sync failed");
        return { pinged: 0 };
      }
    });
  }

  private async syncCard(sessionId: number, opts: CardSyncOptions): Promise<{ pinged: number }> {
    const overview = await getSessionOverview(this.db, sessionId);
    if (!overview) return { pinged: 0 };
    const { session, campaign, groups } = overview;
    const desired = desiredCard(session, campaign, this.now(), { remind: opts.remind });
    const action = planCardSync(session, desired, { announce: opts.announce || opts.remind, refresh: opts.refresh });
    const current = session.discordChannelId && session.discordMessageId
      ? { channelId: session.discordChannelId, messageId: session.discordMessageId }
      : null;

    if (action === "none") return { pinged: 0 };
    if (action === "delete" || !desired) {
      await this.deleteQuietly(current?.channelId ?? null, current?.messageId ?? null);
      await setSessionCard(this.db, session.id, null);
      return { pinged: 0 };
    }
    if (action === "edit" && current) {
      const channel = await this.sendableChannel(campaign.guildId, current.channelId);
      const edited = await this.editOrNull(channel, current.messageId, {
        ...renderSessionCard(overview, desired.kind),
        allowedMentions: { parse: [] },
      });
      // Deleted by someone: forget it so the next tick posts it again if it's still wanted.
      if (!edited) await setSessionCard(this.db, session.id, null);
      return { pinged: 0 };
    }

    // post / repost: the new message goes up first, so a failure leaves the old one in place.
    const reason = opts.remind ? "remind" : current || opts.announce ? "changed" : "new";
    const ping = opts.remind || campaign.reminderPings ? cardPings(desired.kind, groups, reason) : [];
    const channel = await this.sendableChannel(campaign.guildId, desired.channelId);
    const message = await channel.send({ ...renderSessionCard(overview, desired.kind, ping), allowedMentions: { users: ping } });
    await setSessionCard(this.db, session.id, {
      channelId: message.channelId,
      messageId: message.id,
      startsAt: desired.kind === "live" ? session.startsAt : (session.cardStartsAt ?? session.startsAt),
    });
    await this.deleteQuietly(current?.channelId ?? null, current?.messageId ?? null);
    return { pinged: ping.length };
  }

  /**
   * Re-renders every posted card on the server, e.g. after a timezone or
   * campaign change, or when sessions renumber. `except` was just synced.
   */
  async refreshGuildCards(guildId: string, except?: number): Promise<void> {
    for (const id of await listGuildCardSessionIds(this.db, guildId)) {
      if (id !== except) await this.syncSessionCard(id, { refresh: true });
    }
  }

  /** Deletes posted cards whose sessions are gone (e.g. with their campaign). */
  async deleteCards(cards: readonly { channelId: string; messageId: string }[]): Promise<void> {
    for (const card of cards) await this.deleteQuietly(card.channelId, card.messageId);
  }

  /** Waits for queued work and cancels pending debounced refreshes (shutdown). */
  async flush(): Promise<void> {
    for (const timer of this.calendarTimers.values()) clearTimeout(timer);
    this.calendarTimers.clear();
    await Promise.allSettled([...this.queues.values()]);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  private async sendableChannel(guildId: string, channelId: string): Promise<SendableChannels> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable() || !("guildId" in channel) || channel.guildId !== guildId) {
      throw new Error(`channel ${channelId} is not a sendable channel in guild ${guildId}`);
    }
    return channel;
  }

  /** Edits a message; returns null if it no longer exists. */
  private async editOrNull(channel: SendableChannels, messageId: string, edit: MessageEditOptions): Promise<Message | null> {
    try {
      return await channel.messages.edit(messageId, edit);
    } catch (error) {
      if (!isDiscordError(error, GONE_CODES)) throw error;
      this.log.info({ messageId }, "tracked message was deleted");
      return null;
    }
  }

  private async deleteQuietly(channelId: string | null, messageId: string | null): Promise<void> {
    if (!channelId || !messageId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) await channel.messages.delete(messageId);
    } catch (error) {
      if (!isDiscordError(error, GONE_CODES) && !isDiscordError(error, FORBIDDEN_CODES)) {
        this.log.warn({ err: error, channelId, messageId }, "failed to delete old message");
      }
    }
  }
}

