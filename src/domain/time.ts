import { DateTime, IANAZone } from "luxon";
import { UserError } from "./errors.js";
import type { LocalDate, YearMonth } from "./types.js";

/**
 * All timezone handling lives here. Instants are JS Dates (UTC); calendar
 * dates are 'YYYY-MM-DD' strings in a campaign's IANA timezone.
 */

/**
 * Timezones offered by region name instead of a city. They are stored as an
 * IANA zone, so summer time switches by itself.
 */
export const REGION_TIMEZONES: readonly { name: string; zone: string }[] = [
  { name: "Western European Time", zone: "Europe/London" },
  { name: "Central European Time", zone: "Europe/Paris" },
  { name: "Eastern European Time", zone: "Europe/Athens" },
  { name: "US Eastern Time", zone: "America/New_York" },
  { name: "US Central Time", zone: "America/Chicago" },
  { name: "US Mountain Time", zone: "America/Denver" },
  { name: "US Pacific Time", zone: "America/Los_Angeles" },
];

/** Whole-hour fixed offsets: "UTC-12" … "UTC", … "UTC+14". */
export const FIXED_OFFSET_TIMEZONES: readonly string[] = Array.from({ length: 27 }, (_, i) => fixedOffsetZone(i - 12));

function fixedOffsetZone(hours: number): string {
  return hours === 0 ? "UTC" : `UTC${hours > 0 ? "+" : "-"}${Math.abs(hours)}`;
}

export function isValidTimezone(tz: string): boolean {
  return IANAZone.isValidZone(tz) || FIXED_OFFSET_TIMEZONES.includes(tz);
}

/**
 * Accepts a region name ("Central European Time"), a whole-hour offset
 * ("UTC+2", "+2", "GMT-5") or an IANA name, and returns the zone to store.
 */
export function assertTimezone(tz: string): string {
  const trimmed = tz.trim();
  const region = REGION_TIMEZONES.find((r) => r.name.toLowerCase() === trimmed.toLowerCase() || r.zone === trimmed);
  if (region) return region.zone;
  const offset = /^(?:utc|gmt)?\s*(?:([+-])\s*(\d{1,2}))?$/i.exec(trimmed);
  if (offset && trimmed) {
    const hours = offset[1] ? Number(`${offset[1]}${offset[2]}`) : 0;
    if (hours >= -12 && hours <= 14) return fixedOffsetZone(hours);
  }
  if (IANAZone.isValidZone(trimmed)) return trimmed;
  throw new UserError(`"${tz}" is not a timezone I know. Pick one from the suggestions, e.g. Central European Time or UTC+2.`);
}

/** "Central European Time" for a region zone, otherwise the stored name ("UTC+2"). */
export function timezoneName(tz: string): string {
  return REGION_TIMEZONES.find((r) => r.zone === tz)?.name ?? tz;
}

/** The offset in effect at `instant`: "UTC+2", "UTC", "UTC-3:30". */
export function offsetLabel(instant: Date, tz: string): string {
  const minutes = DateTime.fromJSDate(instant, { zone: tz }).offset;
  if (minutes === 0) return "UTC";
  const abs = Math.abs(minutes);
  return `UTC${minutes > 0 ? "+" : "-"}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ""}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{1,2})$/;

export function parseLocalDate(input: string): LocalDate {
  const value = input.trim();
  const m = DATE_RE.exec(value);
  const dt = m ? DateTime.fromObject({ year: +m[1]!, month: +m[2]!, day: +m[3]! }, { zone: "UTC" }) : null;
  if (!dt?.isValid) throw new UserError(`"${input}" is not a valid date. Use YYYY-MM-DD, e.g. 2026-10-17.`);
  return value;
}

/** Accepts 'YYYY-MM' (or 'YYYY-M'). */
export function parseYearMonth(input: string): YearMonth {
  const m = MONTH_RE.exec(input.trim());
  const month = m ? Number(m[2]) : NaN;
  if (!m || month < 1 || month > 12) throw new UserError(`"${input}" is not a valid month. Use YYYY-MM, e.g. 2026-10.`);
  return `${m[1]}-${String(month).padStart(2, "0")}`;
}

/** Accepts 18:00, 18.00, 1800, 18, 6pm, 6:30pm. Returns minutes after midnight. */
export function parseLocalTime(input: string): { hour: number; minute: number } {
  const value = input.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?(am|pm)?$/.exec(value);
  if (m) {
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const meridiem = m[3];
    if (meridiem) {
      if (hour < 1 || hour > 12) hour = -1;
      else if (meridiem === "am") hour = hour === 12 ? 0 : hour;
      else hour = hour === 12 ? 12 : hour + 12;
    }
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }
  throw new UserError(`"${input}" is not a valid time. Use 24-hour HH:MM, e.g. 18:30.`);
}

/**
 * Converts a wall-clock date + time in `tz` to a UTC instant. Rejects times
 * that do not exist because of a DST jump. For ambiguous times (clocks going
 * back) the earlier instant is used.
 */
export function localDateTimeToUtc(date: LocalDate, time: { hour: number; minute: number }, tz: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const dt = DateTime.fromObject({ year, month, day, hour: time.hour, minute: time.minute }, { zone: tz });
  if (!dt.isValid) throw new UserError(`That date/time is not valid in ${tz}.`);
  if (dt.hour !== time.hour || dt.minute !== time.minute || dt.day !== day) {
    throw new UserError(`${date} ${pad(time.hour)}:${pad(time.minute)} does not exist in ${tz} (daylight saving time change).`);
  }
  return dt.toUTC().toJSDate();
}

export function localDateOf(instant: Date, tz: string): LocalDate {
  return DateTime.fromJSDate(instant, { zone: tz }).toISODate()!;
}

export function localTimeOf(instant: Date, tz: string): string {
  return DateTime.fromJSDate(instant, { zone: tz }).toFormat("HH:mm");
}

export function todayIn(tz: string, now: Date = new Date()): LocalDate {
  return localDateOf(now, tz);
}

export function currentMonthIn(tz: string, now: Date = new Date()): YearMonth {
  return todayIn(tz, now).slice(0, 7);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return DateTime.fromISO(date, { zone: "UTC" }).plus({ days }).toISODate()!;
}

export function addMonths(month: YearMonth, months: number): YearMonth {
  return DateTime.fromISO(`${month}-01`, { zone: "UTC" }).plus({ months }).toFormat("yyyy-MM");
}

/** Every date in the month, in order. */
export function daysInMonth(month: YearMonth): LocalDate[] {
  const start = DateTime.fromISO(`${month}-01`, { zone: "UTC" });
  return Array.from({ length: start.daysInMonth! }, (_, i) => start.plus({ days: i }).toISODate()!);
}

export function dateRange(from: LocalDate, count: number): LocalDate[] {
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}

/** UTC bounds [start, end) of a span of local dates in `tz` (inclusive of both dates). */
export function localDatesToUtcRange(first: LocalDate, last: LocalDate, tz: string): { start: Date; end: Date } {
  return {
    start: DateTime.fromISO(first, { zone: tz }).startOf("day").toUTC().toJSDate(),
    end: DateTime.fromISO(last, { zone: tz }).plus({ days: 1 }).startOf("day").toUTC().toJSDate(),
  };
}

/** When the local day containing `instant` ends in `tz`. */
export function endOfLocalDay(instant: Date, tz: string): Date {
  return DateTime.fromJSDate(instant, { zone: tz }).plus({ days: 1 }).startOf("day").toUTC().toJSDate();
}

/** The Monday on or before `date`. */
export function startOfWeek(date: LocalDate): LocalDate {
  return addDays(date, 1 - weekdayOf(date));
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function weekdayOf(date: LocalDate): number {
  return DateTime.fromISO(date, { zone: "UTC" }).weekday;
}

// ── Display formatting (English, campaign timezone) ─────────────────────────

/** "Fri 16 Oct" */
export function formatDayShort(date: LocalDate): string {
  return DateTime.fromISO(date, { zone: "UTC" }).setLocale("en-GB").toFormat("ccc d LLL");
}

/** "Friday 16 October" */
export function formatDayLong(date: LocalDate): string {
  return DateTime.fromISO(date, { zone: "UTC" }).setLocale("en-GB").toFormat("cccc d LLLL");
}

/** "October 2026" */
export function formatMonth(month: YearMonth): string {
  return DateTime.fromISO(`${month}-01`, { zone: "UTC" }).setLocale("en-GB").toFormat("LLLL yyyy");
}

/** "Saturday 17 October — 18:00 (UTC+2)" in the server timezone. */
export function formatSessionTime(startsAt: Date, tz: string): string {
  const start = DateTime.fromJSDate(startsAt, { zone: tz }).setLocale("en-GB");
  return `${start.toFormat("cccc d LLLL")} — ${start.toFormat("HH:mm")} (${offsetLabel(startsAt, tz)})`;
}

/** Discord dynamic timestamp; renders in each viewer's own locale/timezone. */
export function discordTimestamp(instant: Date, style: "F" | "f" | "R" | "t" | "D" | "d" = "f"): string {
  return `<t:${Math.floor(instant.getTime() / 1000)}:${style}>`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
