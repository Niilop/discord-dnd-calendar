export const MEMBER_ROLES = ["admin", "player"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Stored availability statuses. "unspecified" is represented by the absence of a row. */
export const AVAILABILITY_STATUSES = ["unavailable", "prefer_not"] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];
export type AvailabilityValue = AvailabilityStatus | "unspecified";

export const SESSION_STATUSES = ["scheduled", "cancelled", "completed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Stored RSVP statuses. "no response" is represented by the absence of a row. */
export const RSVP_STATUSES = ["attending", "maybe", "absent"] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

/** 'YYYY-MM-DD', a calendar date in the server's timezone. */
export type LocalDate = string;
/** 'YYYY-MM', a calendar month in the server's timezone. */
export type YearMonth = string;

/** Server-wide settings: timezone and the one shared calendar. */
export interface GuildSettings {
  guildId: string;
  timezone: string;
  calendarChannelId: string;
  calendarMessageChannelId: string | null;
  calendarMessageId: string | null;
  calendarMessageMonth: YearMonth | null;
  calendarMessageLayout: number;
}

export interface Campaign {
  id: number;
  guildId: string;
  name: string;
  /** The server's timezone (campaigns don't have their own). */
  timezone: string;
  /** Where session cards go; none if null. */
  rsvpChannelId: string | null;
  /** The last played session's number; upcoming sessions continue from it. */
  currentSession: number;
  /** Minutes before start at which the session card is posted; null = never automatically. */
  reminderMinutes: number | null;
  /** Whether posting or changing a session card pings players. */
  reminderPings: boolean;
  /** '#rrggbb' */
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignMember {
  campaignId: number;
  userId: string;
  role: MemberRole;
}

/** Availability is per server: unavailable on a date means for every campaign. */
export interface AvailabilityEntry {
  guildId: string;
  userId: string;
  date: LocalDate;
  status: AvailabilityStatus;
}

export interface Session {
  id: number;
  campaignId: number;
  /** Optional subtitle: "Session 14: Into the Castle". */
  title: string | null;
  /**
   * "Session N": upcoming sessions are numbered after the campaign's current
   * session in date order; played and cancelled ones keep theirs. Null only
   * for sessions cancelled before numbering existed.
   */
  number: number | null;
  startsAt: Date;
  /** The end of the session's local day: when RSVPs close and it counts as played. */
  endsAt: Date;
  notes: string | null;
  createdBy: string;
  status: SessionStatus;
  scheduleChangedAt: Date;
  /** The session card in the reminder channel, if one is posted. */
  discordChannelId: string | null;
  discordMessageId: string | null;
  /** The start time the posted card was made for. */
  cardStartsAt: Date | null;
  /** The start time before the last reschedule. */
  previousStartsAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Rsvp {
  sessionId: number;
  userId: string;
  status: RsvpStatus;
  updatedAt: Date;
}

/** Start time suggested for a campaign's first session. */
export const FALLBACK_START_TIME = "18:00";
