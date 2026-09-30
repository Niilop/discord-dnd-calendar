import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Guild } from "discord.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db/db.js";
import { GuildAllowlist } from "../../src/discord/guildAllowlist.js";
import { PermissionDeniedError, UserError } from "../../src/domain/errors.js";
import type { Actor } from "../../src/domain/permissions.js";
import { logger } from "../../src/logger.js";
import { AccessList } from "../../src/services/accessService.js";
import { createCampaign } from "../../src/services/campaignService.js";
import { ALICE, BOB, DM, GUILD, OTHER_GUILD, actor, seedServer, serverAdmin } from "../helpers/fixtures.js";
import { createTestDb } from "../helpers/testDb.js";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(async () => {
  await db.close();
});

/** What actorFrom builds for someone without Manage Server in Discord. */
const asSeenBy = (access: AccessList, userId: string, guildId = GUILD): Actor => ({
  ...actor(userId, { guildId }),
  isGuildAdmin: access.hasFullAccess(guildId, userId),
});

describe("bot admins and calendar managers", () => {
  it("gives bot admins full access on every server", () => {
    const access = new AccessList(new Set([ALICE]));
    expect(access.hasFullAccess(GUILD, ALICE)).toBe(true);
    expect(access.hasFullAccess(OTHER_GUILD, ALICE)).toBe(true);
    expect(access.hasFullAccess(GUILD, BOB)).toBe(false);
  });

  it("lets admins and managers add managers, per server, and remembers them across restarts", async () => {
    await seedServer(db);
    const access = new AccessList(new Set([ALICE]));

    await expect(access.addManager(db, asSeenBy(access, BOB), DM)).rejects.toThrow(PermissionDeniedError);
    await access.addManager(db, asSeenBy(access, ALICE), BOB); // bot admin adds Bob
    expect(access.hasFullAccess(GUILD, BOB)).toBe(true);
    expect(access.hasFullAccess(OTHER_GUILD, BOB)).toBe(false);
    await access.addManager(db, asSeenBy(access, BOB), DM); // a manager adds another
    await expect(access.addManager(db, serverAdmin, DM)).rejects.toThrow(UserError);

    // A manager can do what only server admins could before.
    await createCampaign(db, asSeenBy(access, BOB), { name: "Strahd", rsvpChannelId: null, dmUserId: BOB });

    const restarted = new AccessList();
    await restarted.load(db);
    expect(restarted.hasFullAccess(GUILD, DM)).toBe(true);
    expect((await restarted.listManagers(db, GUILD)).managers).toEqual([BOB, DM]);

    await restarted.removeManager(db, serverAdmin, DM);
    expect(restarted.hasFullAccess(GUILD, DM)).toBe(false);
    await expect(restarted.removeManager(db, serverAdmin, DM)).rejects.toThrow(UserError);
  });

  it("reads BOT_ADMIN_USER_IDS", () => {
    const base = { DISCORD_TOKEN: "t", DISCORD_APPLICATION_ID: "1", DATABASE_URL: "postgres://x" };
    expect(loadConfig(base).botAdminUserIds).toEqual([]);
    expect(loadConfig({ ...base, BOT_ADMIN_USER_IDS: `${ALICE}, ${BOB}` }).botAdminUserIds).toEqual([ALICE, BOB]);
    expect(() => loadConfig({ ...base, BOT_ADMIN_USER_IDS: "@me" })).toThrow(/BOT_ADMIN_USER_IDS/);
  });
});

describe("server allowlist", () => {
  const base = { DISCORD_TOKEN: "t", DISCORD_APPLICATION_ID: "1", DATABASE_URL: "postgres://x" };

  it("allows every server when empty, only the listed ones otherwise", () => {
    expect(new GuildAllowlist([]).isAllowed(OTHER_GUILD)).toBe(true);
    const list = new GuildAllowlist(loadConfig({ ...base, ALLOWED_GUILD_IDS: GUILD }).allowedGuildIds);
    expect(list.isAllowed(GUILD)).toBe(true);
    expect(list.isAllowed(OTHER_GUILD)).toBe(false);
    expect(() => loadConfig({ ...base, ALLOWED_GUILD_IDS: "my server" })).toThrow(/server IDs/);
  });

  it("leaves servers that aren't on the list", async () => {
    const left: string[] = [];
    const guild = (id: string) => ({ id, name: id, leave: () => Promise.resolve(void left.push(id)) }) as unknown as Guild;
    const list = new GuildAllowlist([GUILD]);
    const log = logger.child({}, { level: "silent" });
    await list.enforce(guild(GUILD), log);
    await list.enforce(guild(OTHER_GUILD), log);
    expect(left).toEqual([OTHER_GUILD]);
  });
});
