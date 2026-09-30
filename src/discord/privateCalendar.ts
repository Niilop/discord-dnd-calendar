import type { RepliableInteraction } from "discord.js";
import { asEphemeral, type V2Payload } from "./render/calendar.js";

/**
 * Keeps each person down to one private calendar. Opening a new one deletes
 * the previous one through the interaction that last showed it; Discord only
 * allows that within 15 minutes of that interaction, so older ones are left.
 * In memory only: after a restart, the next one simply doesn't replace anything.
 */

const TOKEN_TTL_MS = 14 * 60_000; // a little under Discord's 15 minutes

interface Shown {
  interaction: RepliableInteraction<"cached">;
  /** Settles once the message exists (it can't be deleted before that). */
  ready: Promise<unknown>;
  at: number;
}

const shown = new Map<string, Shown>();
const keyOf = (i: RepliableInteraction<"cached">) => `${i.guildId}:${i.user.id}`;

function remember(i: RepliableInteraction<"cached">, ready: Promise<unknown>, now: number): Shown | undefined {
  for (const [key, entry] of shown) if (now - entry.at > TOKEN_TTL_MS) shown.delete(key);
  const previous = shown.get(keyOf(i));
  shown.set(keyOf(i), { interaction: i, ready, at: now });
  return previous;
}

/** Sends a new private calendar and deletes the person's previous one. */
export async function replyPrivateCalendar(i: RepliableInteraction<"cached">, payload: V2Payload, now = Date.now()): Promise<void> {
  const ready = i.reply(asEphemeral(payload));
  const previous = remember(i, ready, now);
  await ready;
  if (!previous) return;
  // Rapid clicks: wait until the previous message exists before deleting it.
  await previous.ready.catch(() => undefined);
  await previous.interaction.deleteReply().catch(() => undefined); // already dismissed or too old
}

/** Using a private calendar makes it the person's current one (and renews the window for deleting it). */
export function touchPrivateCalendar(i: RepliableInteraction<"cached">, now = Date.now()): void {
  remember(i, Promise.resolve(), now);
}
