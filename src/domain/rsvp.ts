import type { CampaignMember, Rsvp, RsvpStatus, Session } from "./types.js";

export interface RsvpGroups {
  attending: string[];
  maybe: string[];
  absent: string[];
  /** Current members without a response. */
  noResponse: string[];
}

/**
 * Groups responses for display. Members without a row have not responded.
 * Responses from people who have since left the campaign are still shown
 * (they did respond), but they are never counted as "no response".
 */
export function groupRsvps(members: readonly CampaignMember[], rsvps: readonly Rsvp[]): RsvpGroups {
  const groups: RsvpGroups = { attending: [], maybe: [], absent: [], noResponse: [] };
  const responded = new Set<string>();
  const ordered = [...rsvps].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
  for (const rsvp of ordered) {
    groups[rsvp.status].push(rsvp.userId);
    responded.add(rsvp.userId);
  }
  for (const member of members) {
    if (!responded.has(member.userId)) groups.noResponse.push(member.userId);
  }
  return groups;
}

export type RsvpBlockReason = "cancelled" | "completed" | "ended";

/** RSVPs stay open until the session has ended so late changes are still recorded. */
export function rsvpBlockReason(session: Pick<Session, "status" | "endsAt">, now: Date): RsvpBlockReason | null {
  if (session.status === "cancelled") return "cancelled";
  if (session.status === "completed") return "completed";
  if (now >= session.endsAt) return "ended";
  return null;
}

export const RSVP_LABELS: Record<RsvpStatus, string> = {
  attending: "Attending",
  maybe: "Maybe",
  absent: "Can't attend",
};
