import type { Client, EmbedBuilder } from "discord.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { findSession } from "../../src/db/repositories/sessions.js";
import type { AppContext } from "../../src/discord/context.js";
import { Publisher } from "../../src/discord/publisher.js";
import { logger } from "../../src/logger.js";
import { completeSessionsTask, sessionCardsTask } from "../../src/scheduler/tasks.js";
import { AccessList } from "../../src/services/accessService.js";
import { updateCampaign } from "../../src/services/campaignService.js";
import { setupServerCalendar } from "../../src/services/guildService.js";
import { respondToSession } from "../../src/services/rsvpService.js";
import { cancelSession, createSession, editSession } from "../../src/services/sessionService.js";
import { ALICE, BOB, DM, GUILD, actor, seedCampaign, serverAdmin } from "../helpers/fixtures.js";
import { createTestDb } from "../helpers/testDb.js";

const REMINDER_CHANNEL = "300000000000000002";

interface Posted {
  channelId: string;
  content?: string;
  title: string;
  description: string;
  pinged: string[];
}

/** Just enough of a Discord client for the publisher's session cards. */
class FakeDiscord {
  readonly messages = new Map<string, Posted>();
  private nextId = 1;

  readonly client = {
    channels: { fetch: (id: string) => Promise.resolve(this.channel(id)) },
  } as unknown as Client;

  private channel(channelId: string) {
    const toPosted = (p: { content?: string; embeds?: EmbedBuilder[]; allowedMentions?: { users?: string[] } }): Posted => {
      const embed = p.embeds?.[0]?.toJSON();
      return {
        channelId,
        content: p.content,
        title: embed?.title ?? "",
        description: embed?.description ?? "",
        pinged: p.allowedMentions?.users ?? [],
      };
    };
    return {
      id: channelId,
      guildId: GUILD,
      isSendable: () => true,
      isTextBased: () => true,
      send: (p: Parameters<typeof toPosted>[0]) => {
        const id = String(this.nextId++);
        this.messages.set(id, toPosted(p));
        return Promise.resolve({ id, channelId });
      },
      messages: {
        edit: (id: string, p: Parameters<typeof toPosted>[0]) => {
          this.messages.set(id, { ...toPosted(p), pinged: [] });
          return Promise.resolve({ id, channelId });
        },
        delete: (id: string) => {
          this.messages.delete(id);
          return Promise.resolve();
        },
      },
    };
  }

  only(): Posted {
    expect(this.messages.size).toBe(1);
    return [...this.messages.values()][0]!;
  }
}

let db: Db;
let discord: FakeDiscord;
let now: Date;
let ctx: AppContext;

/** Runs one scheduler tick's worth of card work at `at`. */
async function tick(at: string): Promise<void> {
  now = new Date(at);
  await completeSessionsTask.run(ctx, now);
  await sessionCardsTask.run(ctx, now);
}

beforeEach(async () => {
  db = await createTestDb();
  discord = new FakeDiscord();
  now = new Date("2026-10-01T12:00:00Z");
  const log = logger.child({}, { level: "silent" });
  const publisher = new Publisher(discord.client, db, log, () => now);
  ctx = { db, publisher, access: new AccessList(), log, now: () => now };
});
afterEach(async () => {
  await db.close();
});

// Europe/Helsinki is UTC+3 in October: 18:00 local = 15:00Z, the day ends at 21:00Z.
async function scheduled(date = "2026-10-17") {
  const campaign = await seedCampaign(db);
  const { session } = await createSession(db, actor(DM), campaign.id, { date, time: "18:00" }, now);
  await ctx.publisher.syncSessionCard(session.id); // what afterSessionsCreated does
  return { campaign, session };
}

describe("session cards", () => {
  it("posts one card when the 48h window opens, keeps it through the day and removes it after", async () => {
    const { session } = await scheduled();
    expect(discord.messages.size).toBe(0);

    await tick("2026-10-15T14:00:00Z"); // 49h before
    expect(discord.messages.size).toBe(0);

    await tick("2026-10-15T15:00:00Z");
    await tick("2026-10-15T15:01:00Z");
    const card = discord.only();
    expect(card.channelId).toBe(REMINDER_CHANNEL);
    expect(card.title).toContain("Session 1");
    expect(card.pinged).toEqual([]);
    expect(card.content).toBeUndefined();

    await tick("2026-10-17T20:59:00Z"); // late evening: still up
    expect(discord.messages.size).toBe(1);

    await tick("2026-10-17T21:00:00Z"); // midnight in Helsinki: played, card removed
    expect((await findSession(db, session.id))!.status).toBe("completed");
    expect(discord.messages.size).toBe(0);
    expect((await findSession(db, session.id))!.discordMessageId).toBeNull();
  });

  it("posts the card right away for a session created inside the window", async () => {
    now = new Date("2026-10-16T12:00:00Z");
    await scheduled();
    expect(discord.only().title).toContain("Session 1");
  });

  it("posts nothing for a campaign without a reminder channel or with reminders off", async () => {
    const { campaign, session } = await scheduled();
    await updateCampaign(db, actor(DM), campaign.id, { reminderHours: "off" });
    await tick("2026-10-16T12:00:00Z");
    expect(discord.messages.size).toBe(0);

    await updateCampaign(db, actor(DM), campaign.id, { reminderHours: "48", rsvpChannelId: null });
    await ctx.publisher.syncSessionCard(session.id);
    expect(discord.messages.size).toBe(0);
  });

  it("reposts the card with the old time when rescheduled inside the window", async () => {
    const { session } = await scheduled();
    await tick("2026-10-16T12:00:00Z");
    const [firstId] = discord.messages.keys();

    const { campaign, session: moved, timeChanged } = await editSession(db, actor(DM), session.id, { time: "19:00" }, now);
    await ctx.publisher.syncSessionCard(moved.id, { announce: timeChanged, refresh: true });
    expect(campaign.id).toBe(session.campaignId);
    expect(discord.messages.has(firstId!)).toBe(false);
    expect(discord.only().description).toContain("Moved from Sat 17 Oct 18:00");
  });

  it("turns the card into a moved note when the session leaves the window, then posts it again later", async () => {
    const { session } = await scheduled();
    await tick("2026-10-16T12:00:00Z");

    await editSession(db, actor(DM), session.id, { date: "2026-10-24" }, now);
    await ctx.publisher.syncSessionCard(session.id, { announce: true, refresh: true });
    const note = discord.only();
    expect(note.title).toContain("Moved");
    expect(note.description).toContain("Was **Sat 17 Oct 18:00**");

    await tick("2026-10-17T21:00:00Z"); // the old day is over
    expect(discord.messages.size).toBe(0);

    await tick("2026-10-22T15:00:00Z"); // 48h before the new time
    expect(discord.only().title).not.toContain("Moved");
    expect(discord.only().description).toContain("Moved from Sat 17 Oct 18:00");
  });

  it("marks the card cancelled inside the window, and posts nothing for a cancel outside it", async () => {
    const { campaign, session } = await scheduled();
    const { session: later } = await createSession(db, actor(DM), campaign.id, { date: "2026-10-30", time: "18:00" }, now);
    await tick("2026-10-16T12:00:00Z");

    await cancelSession(db, actor(DM), session.id, "DM is sick");
    await cancelSession(db, actor(DM), later.id);
    await ctx.publisher.syncSessionCard(session.id, { announce: true });
    await ctx.publisher.syncSessionCard(later.id, { announce: true });
    const card = discord.only();
    expect(card.title).toContain("CANCELLED");
    expect(card.description).toContain("> DM is sick");

    await tick("2026-10-17T21:00:00Z");
    expect(discord.messages.size).toBe(0);
  });

  it("never pings unless the campaign turns pings on; remind now always pings non-responders", async () => {
    const { campaign, session } = await scheduled();
    await respondToSession(db, actor(ALICE), session.id, "attending", now);

    const reminded = await ctx.publisher.syncSessionCard(session.id, { remind: true }); // before the window
    expect(reminded.pinged).toBe(2);
    expect(discord.only().pinged.sort()).toEqual([BOB, DM].sort());

    await updateCampaign(db, actor(DM), campaign.id, { reminderPings: true });
    await editSession(db, actor(DM), session.id, { time: "19:00" }, now);
    await ctx.publisher.syncSessionCard(session.id, { announce: true, refresh: true });
    expect(discord.only().pinged.sort()).toEqual([ALICE, BOB, DM].sort());
    expect(discord.only().content).toContain(`<@${ALICE}>`);
  });

  it("keeps the clock time when the server timezone changes, and redraws the cards", async () => {
    const { session } = await scheduled();
    await tick("2026-10-16T12:00:00Z");
    expect(discord.only().description).toContain("18:00 (UTC+3)");

    const settings = await setupServerCalendar(db, serverAdmin, {
      timezone: "Central European Time",
      calendarChannelId: "300000000000000001",
    });
    expect(settings).toMatchObject({ timezone: "Europe/Paris", timezoneChanged: true });
    await ctx.publisher.refreshGuildCards(GUILD);

    const moved = (await findSession(db, session.id))!;
    expect(moved.startsAt.toISOString()).toBe("2026-10-17T16:00:00.000Z"); // 18:00 in Paris
    expect(moved.endsAt.toISOString()).toBe("2026-10-17T22:00:00.000Z");
    expect(discord.only().description).toContain("Saturday 17 October — 18:00 (UTC+2)");
    expect(discord.only().title).toBe("Curse of Strahd — Session 1");
  });
});
