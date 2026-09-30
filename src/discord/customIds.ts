import type { AvailabilityValue, RsvpStatus, YearMonth } from "../domain/types.js";

/**
 * Every button/select/modal custom ID is built and parsed here. IDs only carry
 * identifiers and view state (never authority): handlers always reload from the
 * database and re-check permissions. The version prefix lets us reject
 * components rendered by an incompatible older build with a helpful message.
 */
const VERSION = "v4";

/**
 * What the private calendar is showing under the picture: nothing extra
 * (browsing), marking days you can't play, adding sessions, or editing them.
 */
export type CalendarMode = "view" | "avail" | "add" | "edit";

/** Everything a private calendar needs to redraw itself, carried in its components. */
export interface CalendarState {
  mode: CalendarMode;
  month: YearMonth;
  /** Add sessions: the campaign (0 = the DM's first campaign). */
  campaignId: number;
  /** Days picked in the day menu(s): bit (day - 1). */
  mask: number;
  /** Edit sessions: the session being edited (0 = none picked). */
  sessionId: number;
}

/** The days one day menu covers (there are two when a month has more than 25 pickable days). */
export interface DayRange {
  from: number;
  to: number;
}

/** Add sessions: Create (opens the time form) and the form itself. */
export interface BulkState {
  campaignId: number;
  month: YearMonth;
  mask: number;
}

const SESSION_KINDS = ["se.view", "se.camp", "se.time", "se.timeset", "se.cancel", "se.confirm"] as const;
export type SessionPanelKind = (typeof SESSION_KINDS)[number];
const isSessionKind = (k: string): k is SessionPanelKind => (SESSION_KINDS as readonly string[]).includes(k);

export type CustomId =
  /** Open / redraw a calendar: month buttons, mode buttons. On the shared message it opens a private copy. */
  | ({ kind: "cv" } & CalendarState)
  /** Picking days in the day menu (only selects them). */
  | ({ kind: "cv.pick" } & CalendarState & DayRange)
  /** My Availability: apply a mark to the picked days. */
  | { kind: "cv.mark"; month: YearMonth; mask: number; status: AvailabilityValue }
  /** Add sessions: switch campaign (keeps the picked days). */
  | { kind: "cv.camp"; month: YearMonth; mask: number }
  /** Edit sessions: pick a session to edit it under the calendar. */
  | { kind: "cv.edit" }
  | ({ kind: "bk.go" | "bk.create" } & BulkState)
  | { kind: SessionPanelKind; sessionId: number }
  | { kind: "rsvp"; sessionId: number; status: RsvpStatus }
  | { kind: "ss.remind"; sessionId: number };

const codes = <T extends string>(map: Record<T, string>) => [map, new Map(Object.entries(map).map(([k, v]) => [v as string, k as T]))] as const;
const [RSVP_CODES, RSVPS] = codes<RsvpStatus>({ attending: "a", maybe: "m", absent: "x" });
const [MARK_CODES, MARKS] = codes<AvailabilityValue>({ unavailable: "x", prefer_not: "u", unspecified: "c" });
const [MODE_CODES, MODES] = codes<CalendarMode>({ view: "v", avail: "a", add: "s", edit: "e" });

const state = (s: CalendarState) => [MODE_CODES[s.mode], s.month, s.campaignId, s.mask.toString(36), s.sessionId];

export function encodeCustomId(id: CustomId): string {
  const parts: (string | number)[] = (() => {
    switch (id.kind) {
      case "cv":
        return state(id);
      case "cv.pick":
        return [...state(id), id.from, id.to];
      case "cv.mark":
        return [id.month, id.mask.toString(36), MARK_CODES[id.status]];
      case "cv.camp":
        return [id.month, id.mask.toString(36)];
      case "cv.edit":
        return [];
      case "bk.go":
      case "bk.create":
        return [id.campaignId, id.month, id.mask.toString(36)];
      case "rsvp":
        return [id.sessionId, RSVP_CODES[id.status]];
      default:
        return [id.sessionId];
    }
  })();
  return [VERSION, id.kind, ...parts].join(":");
}

const MONTH_RE = /^\d{4}-\d{2}$/;

function int(value: string | undefined): number | null {
  return value && /^\d{1,9}$/.test(value) ? Number(value) : null;
}

function mask(value: string | undefined): number | null {
  if (!value || !/^[0-9a-z]{1,7}$/.test(value)) return null;
  const n = parseInt(value, 36);
  return n < 2 ** 31 ? n : null;
}

const month = (value: string | undefined): YearMonth | null => (value && MONTH_RE.test(value) ? value : null);

function calendarState(parts: (string | undefined)[]): CalendarState | null {
  const [modeCode, monthRaw, campaignRaw, maskRaw, sessionRaw] = parts;
  const mode = modeCode ? MODES.get(modeCode) : undefined;
  const m = month(monthRaw);
  const campaignId = int(campaignRaw);
  const picked = mask(maskRaw);
  const sessionId = int(sessionRaw);
  return mode && m && campaignId !== null && picked !== null && sessionId !== null
    ? { mode, month: m, campaignId, mask: picked, sessionId }
    : null;
}

function range(a: string | undefined, b: string | undefined): DayRange | null {
  const from = int(a);
  const to = int(b);
  return from !== null && to !== null && from >= 1 && from <= to && to <= 31 ? { from, to } : null;
}

function bulk(a: string | undefined, b: string | undefined, c: string | undefined): BulkState | null {
  const campaignId = int(a);
  const m = month(b);
  const picked = mask(c);
  return campaignId !== null && m && picked !== null ? { campaignId, month: m, mask: picked } : null;
}

/** Returns null for anything malformed or from another version. */
export function parseCustomId(raw: string): CustomId | null {
  const [version, kind, ...rest] = raw.split(":");
  if (version !== VERSION || !kind) return null;
  const [a, b, c] = rest;

  switch (kind) {
    case "cv": {
      const s = calendarState(rest);
      return s ? { kind, ...s } : null;
    }
    case "cv.pick": {
      const s = calendarState(rest);
      const days = range(rest[5], rest[6]);
      return s && days ? { kind, ...s, ...days } : null;
    }
    case "cv.mark": {
      const m = month(a);
      const picked = mask(b);
      const status = c ? MARKS.get(c) : undefined;
      return m && picked !== null && status ? { kind, month: m, mask: picked, status } : null;
    }
    case "cv.camp": {
      const m = month(a);
      const picked = mask(b);
      return m && picked !== null ? { kind, month: m, mask: picked } : null;
    }
    case "cv.edit":
      return { kind };
    case "bk.go":
    case "bk.create": {
      const s = bulk(a, b, c);
      return s ? { kind, ...s } : null;
    }
    case "rsvp": {
      const sessionId = int(a);
      const status = b ? RSVPS.get(b) : undefined;
      return sessionId !== null && status ? { kind, sessionId, status } : null;
    }
    case "ss.remind": {
      const sessionId = int(a);
      return sessionId !== null ? { kind, sessionId } : null;
    }
  }
  if (isSessionKind(kind)) {
    const sessionId = int(a);
    return sessionId !== null ? { kind, sessionId } : null;
  }
  return null;
}
