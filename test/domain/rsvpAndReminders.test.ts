import { describe, expect, it } from "vitest";
import { UserError } from "../../src/domain/errors.js";
import { cardPings, desiredCard, parseReminderHours, planCardSync } from "../../src/domain/reminders.js";
import { groupRsvps, rsvpBlockReason } from "../../src/domain/rsvp.js";
import type { CampaignMember, Rsvp } from "../../src/domain/types.js";

const member = (userId: string): CampaignMember => ({ campaignId: 1, userId, role: "player" });
const rsvp = (userId: string, status: Rsvp["status"], t: number): Rsvp => ({
  sessionId: 1,
  userId,
  status,
  updatedAt: new Date(t),
});

describe("groupRsvps", () => {
  it("treats members without a row as no response", () => {
    const groups = groupRsvps(
      [member("a"), member("b"), member("c"), member("d")],
      [rsvp("b", "maybe", 2), rsvp("a", "attending", 1), rsvp("c", "absent", 3)],
    );
    expect(groups).toEqual({ attending: ["a"], maybe: ["b"], absent: ["c"], noResponse: ["d"] });
  });

  it("shows responses from former members but never lists them as missing", () => {
    const groups = groupRsvps([member("a")], [rsvp("gone", "attending", 1)]);
    expect(groups.attending).toEqual(["gone"]);
    expect(groups.noResponse).toEqual(["a"]);
  });
});

describe("rsvpBlockReason", () => {
  const endsAt = new Date("2026-10-17T19:00:00Z");
  it("allows responses until the session ends", () => {
    expect(rsvpBlockReason({ status: "scheduled", endsAt }, new Date("2026-10-17T18:59:00Z"))).toBeNull();
    expect(rsvpBlockReason({ status: "scheduled", endsAt }, endsAt)).toBe("ended");
    expect(rsvpBlockReason({ status: "cancelled", endsAt }, new Date(0))).toBe("cancelled");
  });
});

describe("desiredCard", () => {
  const tz = "Europe/Helsinki"; // UTC+3 in October
  const campaign = { rsvpChannelId: "c1", reminderMinutes: 2880, timezone: tz };
  const startsAt = new Date("2026-10-17T15:00:00Z");
  const base = {
    status: "scheduled" as const,
    startsAt,
    endsAt: new Date("2026-10-17T19:00:00Z"),
    cardStartsAt: null,
    discordChannelId: null,
    discordMessageId: null,
  };
  const posted = { ...base, cardStartsAt: startsAt, discordChannelId: "c1", discordMessageId: "m1" };
  const hoursBefore = (h: number) => new Date(startsAt.getTime() - h * 3_600_000);

  it("wants a live card from the window opening until the session ends, if none is up yet", () => {
    expect(desiredCard(base, campaign, hoursBefore(49))).toBeNull();
    expect(desiredCard(base, campaign, hoursBefore(48))).toEqual({ kind: "live", channelId: "c1" });
    expect(desiredCard(base, campaign, hoursBefore(-5))).toBeNull(); // ended, never posted
    expect(desiredCard(base, campaign, hoursBefore(49), { remind: true })).toEqual({ kind: "live", channelId: "c1" });
  });

  it("keeps a posted card until the end of its local day", () => {
    const done = { ...posted, status: "completed" as const };
    expect(desiredCard(done, campaign, new Date("2026-10-17T20:59:00Z"))?.kind).toBe("live");
    expect(desiredCard(done, campaign, new Date("2026-10-17T21:00:00Z"))).toBeNull();
  });

  it("keeps a moved or cancelled card until the end of the day it was for", () => {
    const moved = { ...posted, startsAt: new Date("2026-10-24T15:00:00Z"), endsAt: new Date("2026-10-24T19:00:00Z") };
    expect(desiredCard(moved, campaign, hoursBefore(20))?.kind).toBe("moved");
    expect(desiredCard(moved, campaign, new Date("2026-10-17T21:00:00Z"))).toBeNull();
    expect(desiredCard({ ...posted, status: "cancelled" }, campaign, hoursBefore(20))?.kind).toBe("cancelled");
    expect(desiredCard({ ...base, status: "cancelled" }, campaign, hoursBefore(20))).toBeNull();
  });

  it("wants nothing without a reminder channel, and nothing automatic with reminders off", () => {
    expect(desiredCard(posted, { ...campaign, rsvpChannelId: null }, hoursBefore(10))).toBeNull();
    expect(desiredCard(base, { ...campaign, reminderMinutes: null }, hoursBefore(10))).toBeNull();
  });
});

describe("planCardSync", () => {
  const startsAt = new Date("2026-10-17T15:00:00Z");
  const base = { status: "scheduled" as const, startsAt, endsAt: startsAt, cardStartsAt: null, discordChannelId: null, discordMessageId: null };
  const posted = { ...base, cardStartsAt: startsAt, discordChannelId: "c1", discordMessageId: "m1" };
  const live = { kind: "live" as const, channelId: "c1" };

  it("posts, deletes, edits only on refresh and reposts on changes", () => {
    expect(planCardSync(base, live)).toBe("post");
    expect(planCardSync(base, null)).toBe("none");
    expect(planCardSync(posted, null)).toBe("delete");
    expect(planCardSync(posted, live)).toBe("none");
    expect(planCardSync(posted, live, { refresh: true })).toBe("edit");
    expect(planCardSync(posted, live, { announce: true })).toBe("repost");
    expect(planCardSync(posted, { ...live, channelId: "c2" })).toBe("repost");
    expect(planCardSync({ ...posted, cardStartsAt: new Date(0) }, live)).toBe("repost");
  });
});

describe("cardPings", () => {
  const groups = { attending: ["a"], maybe: ["m"], absent: ["x"], noResponse: ["n"] };
  it("pings whoever the change matters to", () => {
    expect(cardPings("live", groups, "new")).toEqual(["n"]);
    expect(cardPings("live", groups, "changed")).toEqual(["a", "m", "n"]);
    expect(cardPings("moved", groups, "changed")).toEqual(["a", "m", "n"]);
    expect(cardPings("cancelled", groups, "changed")).toEqual(["a", "m"]);
    expect(cardPings("live", groups, "remind")).toEqual(["n"]);
  });
});

describe("parseReminderHours", () => {
  it("parses one time in hours, or off", () => {
    expect(parseReminderHours("48")).toBe(2880);
    expect(parseReminderHours(" 0.5 ")).toBe(30);
    expect(parseReminderHours("off")).toBeNull();
    expect(() => parseReminderHours("0")).toThrow(UserError);
    expect(() => parseReminderHours("48, 4")).toThrow(UserError);
    expect(() => parseReminderHours("")).toThrow(UserError);
  });
});
