import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { findCampaign } from "../../src/db/repositories/campaigns.js";
import { completeEndedSessions, findSession } from "../../src/db/repositories/sessions.js";
import { PermissionDeniedError, NotFoundError, UserError } from "../../src/domain/errors.js";
import { setOwnAvailability } from "../../src/services/availabilityService.js";
import { buildMonthView } from "../../src/services/calendarService.js";
import { removeMember, updateCampaign } from "../../src/services/campaignService.js";
import { respondToSession } from "../../src/services/rsvpService.js";
import {
  cancelSession,
  createSession,
  createSessions,
  editSession,
  getSessionOverview,
  listUpcomingForActor,
} from "../../src/services/sessionService.js";
import {
  ALICE,
  BOB,
  CAROL,
  DM,
  OTHER_GUILD,
  OUTSIDER,
  actor,
  addRaw,
  seedCampaign,
  seedServer,
  serverAdmin,
} from "../helpers/fixtures.js";
import { createTestDb } from "../helpers/testDb.js";

const NOW = new Date("2026-10-01T12:00:00Z");

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.close();
});

async function scheduled(overrides: { date?: string; time?: string } = {}) {
  const campaign = await seedCampaign(db);
  const { session } = await createSession(
    db,
    actor(DM),
    campaign.id,
    { title: "The Castle", date: overrides.date ?? "2026-10-17", time: overrides.time ?? "18:00" },
    NOW,
  );
  return { campaign, session };
}

describe("session scheduling", () => {
  it("creates sessions in the server timezone, lasting until the end of the day", async () => {
    const { session } = await scheduled();
    expect(session.startsAt.toISOString()).toBe("2026-10-17T15:00:00.000Z");
    expect(session.endsAt.toISOString()).toBe("2026-10-17T21:00:00.000Z"); // midnight in Helsinki
    expect(session.status).toBe("scheduled");
    expect(session.createdBy).toBe(DM);
  });

  it("numbers upcoming sessions after the current session, in date order", async () => {
    const campaign = await seedCampaign(db);
    await updateCampaign(db, actor(DM), campaign.id, { currentSession: 12 });
    const later = await createSession(db, actor(DM), campaign.id, { date: "2026-10-24", time: "18:00", title: " " }, NOW);
    expect(later.session).toMatchObject({ title: null, number: 13 });
    const earlier = await createSession(db, actor(DM), campaign.id, { date: "2026-10-17", time: "18:00" }, NOW);
    expect(earlier.session.number).toBe(13);
    expect((await findSession(db, later.session.id))!.number).toBe(14);

    // Cancelling keeps that session's number and closes the gap for the rest.
    const cancelled = await cancelSession(db, actor(DM), earlier.session.id);
    expect(cancelled.session.number).toBe(13);
    expect((await findSession(db, later.session.id))!.number).toBe(13);

    await updateCampaign(db, actor(DM), campaign.id, { currentSession: 20 });
    expect((await findSession(db, later.session.id))!.number).toBe(21);
  });

  it("completing a session makes it the current one", async () => {
    const campaign = await seedCampaign(db);
    await updateCampaign(db, actor(DM), campaign.id, { currentSession: 4 });
    const first = await createSession(db, actor(DM), campaign.id, { date: "2026-10-17", time: "18:00" }, NOW);
    const second = await createSession(db, actor(DM), campaign.id, { date: "2026-10-24", time: "18:00" }, NOW);

    const done = await db.transaction((tx) => completeEndedSessions(tx, new Date("2026-10-18T00:00:00Z")));
    expect(done.map((s) => [s.id, s.status, s.number])).toEqual([[first.session.id, "completed", 5]]);
    expect((await findCampaign(db, campaign.id))!.currentSession).toBe(5);
    expect((await findSession(db, second.session.id))!.number).toBe(6);
  });

  it("only campaign admins and server admins can create sessions", async () => {
    const campaign = await seedCampaign(db);
    const input = { date: "2026-10-17", time: "18:00" };
    await expect(createSession(db, actor(ALICE), campaign.id, input, NOW)).rejects.toThrow(PermissionDeniedError);
    await expect(createSession(db, actor(OUTSIDER), campaign.id, input, NOW)).rejects.toThrow(PermissionDeniedError);
    await expect(createSession(db, actor(DM, { guildId: OTHER_GUILD }), campaign.id, input, NOW)).rejects.toThrow(
      NotFoundError,
    );
    await expect(createSession(db, serverAdmin, campaign.id, input, NOW)).resolves.toBeTruthy();
  });

  it("rejects past start times and DST-skipped times", async () => {
    const campaign = await seedCampaign(db);
    await expect(createSession(db, actor(DM), campaign.id, { date: "2026-09-01", time: "18:00" }, NOW)).rejects.toThrow(
      /past/,
    );
    await expect(
      createSession(db, actor(DM), campaign.id, { date: "2027-03-28", time: "03:30" }, NOW),
    ).rejects.toThrow(/daylight/);
  });

  it("edits keep unspecified fields and remember the previous start when the time changes", async () => {
    const { session } = await scheduled();

    const renamed = await editSession(db, actor(DM), session.id, { title: "Into the Castle" }, NOW);
    expect(renamed.timeChanged).toBe(false);
    expect(renamed.session.startsAt).toEqual(session.startsAt);
    expect(renamed.session.previousStartsAt).toBeNull();

    const moved = await editSession(db, actor(DM), session.id, { time: "19:30" }, NOW);
    expect(moved.timeChanged).toBe(true);
    expect(moved.session.startsAt.toISOString()).toBe("2026-10-17T16:30:00.000Z");
    expect(moved.session.endsAt.toISOString()).toBe("2026-10-17T21:00:00.000Z");
    expect(moved.session.title).toBe("Into the Castle");
    expect(moved.session.previousStartsAt).toEqual(session.startsAt);
  });

  it("players cannot edit or cancel", async () => {
    const { session } = await scheduled();
    await expect(editSession(db, actor(ALICE), session.id, { title: "x" }, NOW)).rejects.toThrow(PermissionDeniedError);
    await expect(cancelSession(db, actor(ALICE), session.id)).rejects.toThrow(PermissionDeniedError);
  });

  it("cancelled sessions cannot be edited or cancelled again", async () => {
    const { session } = await scheduled();
    await cancelSession(db, actor(DM), session.id);
    await expect(cancelSession(db, actor(DM), session.id)).rejects.toThrow(/already cancelled/);
    await expect(editSession(db, actor(DM), session.id, { title: "x" }, NOW)).rejects.toThrow(UserError);
  });

  it("marks sessions completed at the end of their day", async () => {
    const { session } = await scheduled();
    expect(await completeEndedSessions(db, new Date("2026-10-17T20:59:00Z"))).toEqual([]);
    const done = await completeEndedSessions(db, new Date("2026-10-17T21:00:00Z"));
    expect(done.map((s) => s.id)).toEqual([session.id]);
  });

  it("lists upcoming sessions only where the actor may act", async () => {
    await scheduled();
    expect(await listUpcomingForActor(db, actor(DM), "session.edit", NOW)).toHaveLength(1);
    expect(await listUpcomingForActor(db, actor(ALICE), "session.edit", NOW)).toHaveLength(0);
    expect(await listUpcomingForActor(db, actor(ALICE), "rsvp.respond", NOW)).toHaveLength(1);
  });

  it("builds the server month view: every campaign's sessions in local dates, aggregated availability", async () => {
    const { campaign } = await scheduled({ date: "2026-11-01", time: "01:00" }); // 2026-10-31T23:00Z
    const waterdeep = await seedCampaign(db, { name: "Waterdeep", color: "teal" });
    await createSession(db, actor(DM), waterdeep.id, { date: "2026-11-01", time: "19:00" }, NOW);
    await setOwnAvailability(db, actor(ALICE), ["2026-11-02"], "unavailable");
    const settings = await seedServer(db);

    const oct = await buildMonthView(db, settings, "2026-10", NOW);
    const nov = await buildMonthView(db, settings, "2026-11", NOW);
    expect(oct.sessions).toHaveLength(0);
    expect(nov.sessions.map((s) => [s.localDate, s.campaign.name])).toEqual([
      ["2026-11-01", campaign.name],
      ["2026-11-01", "Waterdeep"],
    ]);
    expect(nov.sessions[0]!.counts.noResponse).toBe(3);
    expect(nov.availability.get("2026-11-02")!.unavailable).toEqual([ALICE]);
    expect(nov.campaigns.map((c) => c.color)).toEqual(["#e5484d", "#12a594"]);
  });
});

describe("bulk scheduling", () => {
  it("creates one session per date at the campaign's usual time, numbered in date order", async () => {
    const campaign = await seedCampaign(db);
    await createSession(db, actor(DM), campaign.id, { date: "2026-10-03", time: "18:00" }, NOW); // Session 1
    const { sessions } = await createSessions(db, actor(DM), campaign.id, { dates: ["2026-10-17", "2026-10-10"] }, NOW);
    expect(sessions.map((s) => [s.number, s.startsAt.toISOString()])).toEqual([
      [2, "2026-10-10T15:00:00.000Z"],
      [3, "2026-10-17T15:00:00.000Z"],
    ]);
  });

  it("takes an explicit time", async () => {
    const campaign = await seedCampaign(db);
    const { sessions } = await createSessions(db, actor(DM), campaign.id, { dates: ["2026-10-10"], time: "17:30" }, NOW);
    expect(sessions[0]!.startsAt.toISOString()).toBe("2026-10-10T14:30:00.000Z");
  });

  it("is all or nothing and DM-only", async () => {
    const campaign = await seedCampaign(db);
    await expect(createSessions(db, actor(DM), campaign.id, { dates: ["2026-09-30", "2026-10-10"] }, NOW)).rejects.toThrow(
      /already past/,
    );
    await expect(createSessions(db, actor(ALICE), campaign.id, { dates: ["2026-10-10"] }, NOW)).rejects.toThrow(
      PermissionDeniedError,
    );
    expect(await listUpcomingForActor(db, actor(DM), "session.edit", NOW)).toHaveLength(0);
  });
});

describe("moving a session to another campaign", () => {
  it("changes the campaign, keeps the time, drops RSVPs from non-members", async () => {
    const { session } = await scheduled();
    const waterdeep = await seedCampaign(db, { name: "Waterdeep", color: "teal" });
    await addRaw(db, waterdeep.id, CAROL, "player");
    await removeMember(db, serverAdmin, waterdeep.id, BOB, NOW);
    await respondToSession(db, actor(ALICE), session.id, "attending", NOW);
    await respondToSession(db, actor(BOB), session.id, "attending", NOW);

    const result = await editSession(db, actor(DM), session.id, { campaignId: waterdeep.id }, NOW);
    expect(result.moved).toBe(true);
    expect(result.timeChanged).toBe(false);
    expect(result.session.campaignId).toBe(waterdeep.id);
    expect(result.session.startsAt).toEqual(session.startsAt);

    const overview = (await getSessionOverview(db, session.id))!;
    expect(overview.groups.attending).toEqual([ALICE]); // Bob isn't in Waterdeep
    expect(overview.groups.noResponse.sort()).toEqual([CAROL, DM].sort());
  });

  it("requires scheduling rights in the target campaign", async () => {
    const { session } = await scheduled();
    const other = await seedCampaign(db, { name: "Waterdeep", color: "teal" });
    await removeMember(db, serverAdmin, other.id, DM, NOW); // DM is not a DM there
    await expect(editSession(db, actor(DM), session.id, { campaignId: other.id }, NOW)).rejects.toThrow(PermissionDeniedError);
    await expect(editSession(db, serverAdmin, session.id, { campaignId: other.id }, NOW)).resolves.toMatchObject({ moved: true });
  });
});

describe("RSVPs", () => {
  it("records and changes a member's own response", async () => {
    const { session } = await scheduled();
    const first = await respondToSession(db, actor(ALICE), session.id, "attending", NOW);
    expect(first.previous).toBeNull();
    const second = await respondToSession(db, actor(ALICE), session.id, "absent", NOW);
    expect(second.previous).toBe("attending");
    await respondToSession(db, actor(BOB), session.id, "maybe", NOW);

    const overview = (await getSessionOverview(db, session.id))!;
    expect(overview.groups).toEqual({ attending: [], maybe: [BOB], absent: [ALICE], noResponse: [DM] });
  });

  it("availability does not imply attendance", async () => {
    const { session } = await scheduled();
    await setOwnAvailability(db, actor(ALICE), ["2026-10-17"], "unavailable");
    const overview = (await getSessionOverview(db, session.id))!;
    expect(overview.groups.noResponse).toContain(ALICE);
    expect(overview.groups.absent).toEqual([]);
  });

  it("rejects non-members, other guilds and closed sessions", async () => {
    const { session } = await scheduled();
    await expect(respondToSession(db, actor(OUTSIDER), session.id, "attending", NOW)).rejects.toThrow(
      PermissionDeniedError,
    );
    await expect(
      respondToSession(db, actor(ALICE, { guildId: OTHER_GUILD }), session.id, "attending", NOW),
    ).rejects.toThrow(NotFoundError);
    await expect(respondToSession(db, actor(ALICE), session.id, "attending", new Date("2026-10-17T21:00:00Z"))).rejects.toThrow(
      /ended/,
    );
    await cancelSession(db, actor(DM), session.id);
    await expect(respondToSession(db, actor(ALICE), session.id, "attending", NOW)).rejects.toThrow(/cancelled/);
  });

  it("removing a member drops their responses to upcoming sessions", async () => {
    const { campaign, session } = await scheduled();
    await respondToSession(db, actor(BOB), session.id, "attending", NOW);
    await removeMember(db, actor(DM), campaign.id, BOB, NOW);
    const overview = (await getSessionOverview(db, session.id))!;
    expect(overview.groups.attending).toEqual([]);
    expect(overview.groups.noResponse).not.toContain(BOB);
  });
});
