import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { listMembers } from "../../src/db/repositories/members.js";
import { PermissionDeniedError, NotFoundError, UserError } from "../../src/domain/errors.js";
import { setOwnAvailability, summarizeGuildDates } from "../../src/services/availabilityService.js";
import { setupServerCalendar } from "../../src/services/guildService.js";
import {
  addMember,
  createCampaign,
  deleteCampaign,
  getCampaignOverview,
  listVisibleCampaigns,
  removeMember,
  updateCampaign,
} from "../../src/services/campaignService.js";
import {
  ALICE,
  BOB,
  CAROL,
  DM,
  GUILD,
  OTHER_GUILD,
  OUTSIDER,
  actor,
  seedCampaign,
  seedServer,
  serverAdmin,
} from "../helpers/fixtures.js";
import { createTestDb } from "../helpers/testDb.js";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.close();
});

describe("campaigns", () => {
  it("only server admins can create campaigns; the DM becomes a campaign admin", async () => {
    await seedServer(db);
    await expect(
      createCampaign(db, actor(DM), { name: "X", rsvpChannelId: "2", dmUserId: DM }),
    ).rejects.toThrow(PermissionDeniedError);

    const campaign = await seedCampaign(db);
    const members = await listMembers(db, campaign.id);
    expect(members.find((m) => m.userId === DM)?.role).toBe("admin");
    expect(campaign).toMatchObject({
      currentSession: 0,
      reminderMinutes: 2880,
      reminderPings: false,
      color: "#e5484d",
      timezone: "Europe/Helsinki",
    });
  });

  it("requires the server calendar to be set up first", async () => {
    await expect(
      createCampaign(db, serverAdmin, { name: "X", rsvpChannelId: "2", dmUserId: DM }),
    ).rejects.toThrow(/calendar setup/);
  });

  it("takes its timezone from the server", async () => {
    const campaign = await seedCampaign(db);
    await seedServer(db, "America/New_York");
    expect((await getCampaignOverview(db, actor(DM), campaign.id)).campaign.timezone).toBe("America/New_York");
    await expect(seedServer(db, "Mars/Olympus")).rejects.toThrow(UserError);
    await expect(setupServerCalendar(db, actor(DM), { timezone: "UTC", calendarChannelId: "1" })).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it("rejects duplicate names per guild (case-insensitive)", async () => {
    await seedCampaign(db);
    await expect(seedCampaign(db, { name: "curse of strahd" })).rejects.toThrow(/already exists/);
  });

  it("scopes campaigns to their guild", async () => {
    const campaign = await seedCampaign(db);
    await expect(getCampaignOverview(db, actor(ALICE, { guildId: OTHER_GUILD }), campaign.id)).rejects.toThrow(NotFoundError);
    await expect(getCampaignOverview(db, actor(OUTSIDER), campaign.id)).rejects.toThrow(PermissionDeniedError);
    expect((await getCampaignOverview(db, actor(ALICE), campaign.id)).role).toBe("player");
  });

  it("campaign admins can edit settings; players cannot", async () => {
    const campaign = await seedCampaign(db);
    await expect(updateCampaign(db, actor(ALICE), campaign.id, { name: "Hacked" })).rejects.toThrow(PermissionDeniedError);
    const updated = await updateCampaign(db, actor(DM), campaign.id, {
      reminderHours: "24",
      reminderPings: true,
      currentSession: 12,
      color: "#12A594",
      rsvpChannelId: null,
    });
    expect(updated.reminderMinutes).toBe(1440);
    expect(updated.reminderPings).toBe(true);
    expect(updated.currentSession).toBe(12);
    expect(updated.color).toBe("#12a594");
    expect(updated.rsvpChannelId).toBeNull();
  });

  it("deletion requires server admin and the exact name", async () => {
    const campaign = await seedCampaign(db);
    await expect(deleteCampaign(db, actor(DM), campaign.id, campaign.name)).rejects.toThrow(PermissionDeniedError);
    await expect(deleteCampaign(db, serverAdmin, campaign.id, "wrong")).rejects.toThrow(/confirm/);
    await deleteCampaign(db, serverAdmin, campaign.id, "CURSE OF STRAHD");
    expect(await listVisibleCampaigns(db, serverAdmin)).toEqual([]);
  });

  it("lists campaigns: members see theirs, server admins see all", async () => {
    await seedCampaign(db);
    await seedCampaign(db, { name: "Other" }).then((c) => removeMember(db, serverAdmin, c.id, ALICE));
    expect((await listVisibleCampaigns(db, actor(ALICE))).map((c) => c.campaign.name)).toEqual(["Curse of Strahd"]);
    expect(await listVisibleCampaigns(db, actor(OUTSIDER))).toEqual([]);
    expect(await listVisibleCampaigns(db, serverAdmin)).toHaveLength(2);
  });
});

describe("membership", () => {
  it("campaign admins can add and remove players", async () => {
    const campaign = await seedCampaign(db);
    await addMember(db, actor(DM), campaign.id, CAROL, "player");
    await expect(addMember(db, actor(DM), campaign.id, CAROL, "player")).rejects.toThrow(/already/);
    await removeMember(db, actor(DM), campaign.id, CAROL);
    expect((await listMembers(db, campaign.id)).map((m) => m.userId)).not.toContain(CAROL);
  });

  it("players cannot manage membership", async () => {
    const campaign = await seedCampaign(db);
    await expect(addMember(db, actor(ALICE), campaign.id, CAROL, "player")).rejects.toThrow(PermissionDeniedError);
    await expect(removeMember(db, actor(ALICE), campaign.id, BOB)).rejects.toThrow(PermissionDeniedError);
  });

  it("only server admins can grant or revoke campaign admin", async () => {
    const campaign = await seedCampaign(db);
    await expect(addMember(db, actor(DM), campaign.id, ALICE, "admin")).rejects.toThrow(PermissionDeniedError);
    await addMember(db, serverAdmin, campaign.id, ALICE, "admin");
    await expect(removeMember(db, actor(DM), campaign.id, ALICE)).rejects.toThrow(PermissionDeniedError);
    await expect(addMember(db, actor(DM), campaign.id, ALICE, "player")).rejects.toThrow(PermissionDeniedError);
  });

  it("someone removed from their only campaign stops counting towards availability", async () => {
    const campaign = await seedCampaign(db);
    await setOwnAvailability(db, actor(ALICE), ["2026-10-17"], "unavailable");
    await removeMember(db, actor(DM), campaign.id, ALICE);
    const { summary, memberCount } = await summarizeGuildDates(db, GUILD, ["2026-10-17"]);
    expect(memberCount).toBe(2);
    expect(summary.get("2026-10-17")!.unavailable).toEqual([]);
  });

  it("uses the latest membership: a removed player loses access immediately", async () => {
    const campaign = await seedCampaign(db);
    await removeMember(db, actor(DM), campaign.id, BOB);
    await expect(setOwnAvailability(db, actor(BOB), ["2026-10-17"], "unavailable")).rejects.toThrow(PermissionDeniedError);
  });
});
