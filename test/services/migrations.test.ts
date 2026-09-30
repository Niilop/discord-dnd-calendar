import { mkdtemp, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, runMigrations } from "../../src/db/migrate.js";
import { createTestDb } from "../helpers/testDb.js";

describe("0003 server calendar migration", () => {
  it("keeps existing campaigns and merges availability per server (unavailable wins)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "migrations-"));
    for (const f of ["0001_initial_schema.sql", "0002_campaign_color.sql"]) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const db = await createTestDb({ migrate: false });
    try {
      await runMigrations(db, dir);
      await db.query(`
        INSERT INTO campaign (guild_id, name, timezone, calendar_channel_id, rsvp_channel_id, color)
        VALUES ('g1', 'Strahd', 'Europe/Helsinki', 'cal1', 'rsvp1', '#e5484d'),
               ('g1', 'Waterdeep', 'UTC', 'cal2', 'rsvp2', '#12a594');
        INSERT INTO campaign_member VALUES (1, 'alice', 'player', now()), (2, 'alice', 'player', now());
        INSERT INTO availability (campaign_id, discord_user_id, date, status) VALUES
          (1, 'alice', '2026-10-16', 'prefer_not'), (2, 'alice', '2026-10-16', 'unavailable'),
          (1, 'alice', '2026-10-17', 'prefer_not');
        INSERT INTO session (campaign_id, title, starts_at, ends_at, created_by)
        VALUES (2, 'S1', '2026-10-17T15:00Z', '2026-10-17T19:00Z', 'dm');`);

      await runMigrations(db); // the real directory: applies 0003

      expect(await db.query("SELECT guild_id, timezone, calendar_channel_id FROM guild_settings")).toEqual([
        { guild_id: "g1", timezone: "Europe/Helsinki", calendar_channel_id: "cal1" },
      ]);
      expect(await db.query("SELECT date::text, status FROM availability ORDER BY date")).toEqual([
        { date: "2026-10-16", status: "unavailable" },
        { date: "2026-10-17", status: "prefer_not" },
      ]);
      expect(await db.query("SELECT count(*)::int AS n FROM session")).toEqual([{ n: 1 }]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true });
    }
  });
});

describe("0005 session cards migration", () => {
  it("keeps the longest reminder time, and none for campaigns with reminders off", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "migrations-"));
    const before = ["0001_initial_schema.sql", "0002_campaign_color.sql", "0003_server_calendar.sql", "0004_optional_reminder_channel.sql"];
    for (const f of before) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const db = await createTestDb({ migrate: false });
    try {
      await runMigrations(db, dir);
      await db.query(`
        INSERT INTO guild_settings (guild_id, timezone, calendar_channel_id) VALUES ('g1', 'UTC', 'cal');
        INSERT INTO campaign (guild_id, name, rsvp_channel_id, reminder_offsets_minutes) VALUES
          ('g1', 'Two', 'r', '{2880,240}'), ('g1', 'Off', 'r', '{}');`);

      await runMigrations(db);

      expect(await db.query("SELECT name, reminder_minutes, reminder_pings FROM campaign ORDER BY id")).toEqual([
        { name: "Two", reminder_minutes: 2880, reminder_pings: false },
        { name: "Off", reminder_minutes: null, reminder_pings: false },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true });
    }
  });
});

describe("0006 session numbers migration", () => {
  it("turns generated titles into numbers and makes upcoming sessions end at midnight", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "migrations-"));
    const before = [
      "0001_initial_schema.sql",
      "0002_campaign_color.sql",
      "0003_server_calendar.sql",
      "0004_optional_reminder_channel.sql",
      "0005_session_cards.sql",
    ];
    for (const f of before) await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const db = await createTestDb({ migrate: false });
    try {
      await runMigrations(db, dir);
      await db.query(`
        INSERT INTO guild_settings (guild_id, timezone, calendar_channel_id) VALUES ('g1', 'Europe/Helsinki', 'cal');
        INSERT INTO campaign (guild_id, name, rsvp_channel_id) VALUES ('g1', 'Strahd', 'r');
        INSERT INTO session (campaign_id, title, starts_at, ends_at, created_by, status) VALUES
          (1, 'Session 1', '2026-10-03T15:00Z', '2026-10-03T19:00Z', 'dm', 'completed'),
          (1, 'Session 2', '2026-10-10T15:00Z', '2026-10-10T19:00Z', 'dm', 'completed'),
          (1, 'Into the Castle', '2026-10-17T15:00Z', '2026-10-17T19:00Z', 'dm', 'scheduled');`);

      await runMigrations(db);

      expect(await db.query("SELECT current_session FROM campaign")).toEqual([{ current_session: 2 }]);
      const rows = await db.query<{ title: string | null; display_number: number; ends_at: Date }>(
        "SELECT title, display_number, ends_at FROM session_numbered ORDER BY starts_at",
      );
      expect(rows.map((r) => [r.title, r.display_number])).toEqual([
        [null, 1],
        [null, 2],
        ["Into the Castle", 3],
      ]);
      expect(rows[2]!.ends_at.toISOString()).toBe("2026-10-17T21:00:00.000Z");
    } finally {
      await db.close();
      await rm(dir, { recursive: true });
    }
  });
});
