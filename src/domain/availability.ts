import type { AvailabilityEntry, AvailabilityStatus, AvailabilityValue, LocalDate } from "./types.js";

export interface DayAvailability {
  date: LocalDate;
  /** Members with no entry for the day. */
  available: number;
  total: number;
  unavailable: string[];
  preferNot: string[];
}

/**
 * Aggregates availability per day for the given members. Entries from users
 * who are no longer members are ignored. Availability is only information for
 * the scheduler — nothing here recommends a date.
 */
export function summarizeAvailability(
  dates: readonly LocalDate[],
  memberIds: readonly string[],
  entries: readonly AvailabilityEntry[],
): Map<LocalDate, DayAvailability> {
  const members = new Set(memberIds);
  const byDate = new Map<LocalDate, DayAvailability>(
    dates.map((date) => [date, { date, available: members.size, total: members.size, unavailable: [], preferNot: [] }]),
  );
  for (const entry of entries) {
    const day = byDate.get(entry.date);
    if (!day || !members.has(entry.userId)) continue;
    (entry.status === "unavailable" ? day.unavailable : day.preferNot).push(entry.userId);
    day.available -= 1;
  }
  return byDate;
}

/**
 * "2 can't · 1 unsure", or "nobody marked" — people who haven't marked a day
 * are unknown, never "available".
 */
export function describeDayAvailability(day: DayAvailability): string {
  const parts: string[] = [];
  if (day.unavailable.length) parts.push(`${day.unavailable.length} can't`);
  if (day.preferNot.length) parts.push(`${day.preferNot.length} unsure`);
  return parts.join(" · ") || "nobody marked";
}

/** "2 unavailable, 1 unsure" — or null when nobody has marked anything. */
export function describeDayConflicts(day: DayAvailability): string | null {
  const parts: string[] = [];
  if (day.unavailable.length) parts.push(`${day.unavailable.length} unavailable`);
  if (day.preferNot.length) parts.push(`${day.preferNot.length} unsure`);
  return parts.length ? parts.join(", ") : null;
}

export function toAvailabilityStatus(value: AvailabilityValue): AvailabilityStatus | null {
  return value === "unspecified" ? null : value;
}
