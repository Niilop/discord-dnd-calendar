import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { listAvailability } from "../../src/db/repositories/availability.js";
import { PermissionDeniedError, UserError } from "../../src/domain/errors.js";
import {
  getDayDetail,
  getOwnAvailability,
  setOwnAvailability,
  summarizeCampaignDates,
} from "../../src/services/availabilityService.js";
import { daysInMonth } from "../../src/domain/time.js";
import { createSession } from "../../src/services/sessionService.js";
import { ALICE, BOB, CAROL, DM, GUILD, OUTSIDER, actor, addRaw, seedCampaign, serverAdmin } from "../helpers/fixtures.js";
import { createTestDb } from "../helpers/testDb.js";

const NOW = new Date("2026-10-01T12:00:00Z");

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.close();
});

describe("availability", () => {
  it("sets, overwrites and clears the actor's own availability", async () => {
    await seedCampaign(db);
    await setOwnAvailability(db, actor(ALICE), ["2026-10-16", "2026-10-17"], "unavailable");
    await setOwnAvailability(db, actor(ALICE), ["2026-10-17"], "prefer_not");
    let own = await getOwnAvailability(db, actor(ALICE), "2026-10-01", "2026-10-31");
    expect(Object.fromEntries(own.statuses)).toEqual({ "2026-10-16": "unavailable", "2026-10-17": "prefer_not" });

    // "unspecified" is stored as no row.
    await setOwnAvailability(db, actor(ALICE), ["2026-10-16"], "unspecified");
    own = await getOwnAvailability(db, actor(ALICE), "2026-10-01", "2026-10-31");
    expect(Object.fromEntries(own.statuses)).toEqual({ "2026-10-17": "prefer_not" });
    expect(await listAvailability(db, GUILD, "2026-10-01", "2026-10-31")).toHaveLength(1);
  });

  it("is per server: one mark counts for every campaign the player is in", async () => {
    const strahd = await seedCampaign(db);
    const waterdeep = await seedCampaign(db, { name: "Waterdeep", color: "teal" });
    await setOwnAvailability(db, actor(ALICE), ["2026-10-17"], "unavailable");
    for (const campaign of [strahd, waterdeep]) {
      const summary = await summarizeCampaignDates(db, campaign, ["2026-10-17"]);
      expect(summary.get("2026-10-17")!.unavailable).toEqual([ALICE]);
    }
  });

  it("only counts a campaign's own members when scheduling for it", async () => {
    const strahd = await seedCampaign(db);
    const waterdeep = await seedCampaign(db, { name: "Waterdeep", color: "teal" });
    await addRaw(db, waterdeep.id, CAROL, "player");
    await setOwnAvailability(db, actor(CAROL), ["2026-10-17"], "unavailable");
    expect((await summarizeCampaignDates(db, strahd, ["2026-10-17"])).get("2026-10-17")).toMatchObject({ available: 3, total: 3 });
    expect((await summarizeCampaignDates(db, waterdeep, ["2026-10-17"])).get("2026-10-17")).toMatchObject({ available: 3, total: 4 });
  });

  it("requires being in a campaign, even for server admins", async () => {
    await seedCampaign(db);
    await expect(setOwnAvailability(db, actor(OUTSIDER), ["2026-10-17"], "unavailable")).rejects.toThrow(PermissionDeniedError);
    await expect(setOwnAvailability(db, serverAdmin, ["2026-10-17"], "unavailable")).rejects.toThrow(PermissionDeniedError);
  });

  it("validates dates", async () => {
    await seedCampaign(db);
    await expect(setOwnAvailability(db, actor(ALICE), ["2026-02-31"], "unavailable")).rejects.toThrow(UserError);
    await expect(setOwnAvailability(db, actor(ALICE), [], "unavailable")).rejects.toThrow(UserError);
  });

  it("day details show sessions from every campaign and who is unavailable to members only", async () => {
    const strahd = await seedCampaign(db);
    const waterdeep = await seedCampaign(db, { name: "Waterdeep", color: "teal" });
    await createSession(db, actor(DM), strahd.id, { date: "2026-10-17", time: "13:00" }, NOW);
    await createSession(db, actor(DM), waterdeep.id, { date: "2026-10-17", time: "19:00" }, NOW);
    await setOwnAvailability(db, actor(ALICE), ["2026-10-17"], "unavailable");

    const forBob = await getDayDetail(db, actor(BOB), "2026-10-17");
    expect(forBob.showNames).toBe(true);
    expect(forBob.summary.unavailable).toEqual([ALICE]);
    expect(forBob.ownStatus).toBe("unspecified");
    expect(forBob.sessions.map((s) => s.campaign.name)).toEqual(["Curse of Strahd", "Waterdeep"]);

    const forOutsider = await getDayDetail(db, actor(OUTSIDER), "2026-10-17");
    expect(forOutsider.showNames).toBe(false);
    expect(forOutsider.ownStatus).toBeNull();
  });

  it("counts only the campaign's own players when adding sessions for it", async () => {
    const strahd = await seedCampaign(db);
    await setOwnAvailability(db, actor(ALICE), ["2026-10-16"], "unavailable");
    await setOwnAvailability(db, actor(BOB), ["2026-10-16"], "prefer_not");

    const summary = await summarizeCampaignDates(db, strahd, daysInMonth("2026-10"));
    expect(summary.get("2026-10-16")).toMatchObject({ available: 1, total: 3 });
  });
});
