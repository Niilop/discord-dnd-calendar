import { ActionRowBuilder, StringSelectMenuBuilder, type MessageActionRowComponentBuilder } from "discord.js";
import { daysInMonth } from "../../domain/time.js";
import type { LocalDate, YearMonth } from "../../domain/types.js";
import { truncate } from "./format.js";

/**
 * Picking days from multi-select menus. The picked days ride in custom IDs as
 * a bitmask, so there's no server-side state. Month-based helpers use bit
 * (day - 1); the availability panel uses its own offset-based mask.
 */

const MAX_OPTIONS = 25; // Discord's limit per select menu
const SPLIT_AFTER_DAY = 15;

export const dayOfMonth = (date: LocalDate) => Number(date.slice(8));

export function datesInMask(month: YearMonth, mask: number): LocalDate[] {
  return daysInMonth(month).filter((d) => (mask & (1 << (dayOfMonth(d) - 1))) !== 0);
}

export function maskOf(dates: readonly LocalDate[]): number {
  return dates.reduce((mask, d) => mask | (1 << (dayOfMonth(d) - 1)), 0);
}

/** Replaces the picks for days `from`..`to` (one menu's range) with `picked`, keeping the rest. */
export function applyPick(mask: number, from: number, to: number, picked: readonly number[]): number {
  let next = mask;
  for (let day = from; day <= to; day++) next &= ~(1 << (day - 1));
  for (const day of picked) if (day >= from && day <= to) next |= 1 << (day - 1);
  return next;
}

export interface DayOption {
  date: LocalDate;
  label: string;
  description?: string;
  emoji?: string;
}

/** One multi-select menu of days; `value` of each option is what the handler receives. */
export function dayMenu(
  options: readonly (DayOption & { value: string; picked: boolean })[],
  customId: string,
  placeholder: string,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(0)
    .setMaxValues(options.length)
    .addOptions(
      options.map((o) => ({
        label: o.label,
        value: o.value,
        default: o.picked,
        ...(o.description ? { description: truncate(o.description, 100) } : {}),
        ...(o.emoji ? { emoji: o.emoji } : {}),
      })),
    );
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu);
}

/**
 * Days of one month: one menu, or two (1–15 and 16–end) when there are more
 * than Discord's 25 options — only a full future month needs that.
 */
export function dayMenuRows(
  options: readonly DayOption[],
  mask: number,
  customId: (from: number, to: number) => string,
  placeholder: string,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  if (!options.length) return [];
  const parts =
    options.length <= MAX_OPTIONS
      ? [options]
      : [options.filter((o) => dayOfMonth(o.date) <= SPLIT_AFTER_DAY), options.filter((o) => dayOfMonth(o.date) > SPLIT_AFTER_DAY)];

  return parts.map((part) => {
    const from = dayOfMonth(part[0]!.date);
    const to = dayOfMonth(part.at(-1)!.date);
    return dayMenu(
      part.map((o) => ({ ...o, value: String(dayOfMonth(o.date)), picked: (mask & (1 << (dayOfMonth(o.date) - 1))) !== 0 })),
      customId(from, to),
      parts.length > 1 ? `${placeholder} (${from}–${to})` : placeholder,
    );
  });
}
