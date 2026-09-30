import type { RepliableInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { replyPrivateCalendar, touchPrivateCalendar } from "../../src/discord/privateCalendar.js";
import type { V2Payload } from "../../src/discord/render/calendar.js";

const payload = { components: [], files: [] } as unknown as V2Payload;

/** A fake interaction whose reply resolves when `send()` is called. */
function fake(userId: string) {
  let send!: () => void;
  const sent = new Promise<void>((resolve) => (send = resolve));
  const i = {
    guildId: "g",
    user: { id: userId },
    reply: vi.fn(() => sent),
    deleteReply: vi.fn(() => Promise.resolve()),
  };
  return { i: i as unknown as RepliableInteraction<"cached">, mock: i, send };
}

describe("one private calendar per person", () => {
  it("deletes the previous one when a new one opens", async () => {
    const first = fake("a");
    first.send();
    await replyPrivateCalendar(first.i, payload);
    const second = fake("a");
    second.send();
    await replyPrivateCalendar(second.i, payload);
    expect(first.mock.deleteReply).toHaveBeenCalledOnce();
    expect(second.mock.deleteReply).not.toHaveBeenCalled();
  });

  it("with rapid clicks, waits for the previous message to exist before deleting it", async () => {
    const first = fake("b");
    const second = fake("b");
    const opening = replyPrivateCalendar(first.i, payload);
    const replacing = replyPrivateCalendar(second.i, payload);
    second.send();
    await Promise.resolve();
    expect(first.mock.deleteReply).not.toHaveBeenCalled(); // first isn't sent yet
    first.send();
    await Promise.all([opening, replacing]);
    expect(first.mock.deleteReply).toHaveBeenCalledOnce();
  });

  it("deletes the one last used, and leaves other people's alone", async () => {
    const opened = fake("c");
    opened.send();
    await replyPrivateCalendar(opened.i, payload);
    const used = fake("c");
    touchPrivateCalendar(used.i);
    const other = fake("d");
    other.send();
    await replyPrivateCalendar(other.i, payload);
    const next = fake("c");
    next.send();
    await replyPrivateCalendar(next.i, payload);
    expect(used.mock.deleteReply).toHaveBeenCalledOnce();
    expect(opened.mock.deleteReply).not.toHaveBeenCalled();
  });

  it("leaves one it can no longer delete (Discord's 15-minute limit)", async () => {
    const old = fake("e");
    old.send();
    await replyPrivateCalendar(old.i, payload, 0);
    const next = fake("e");
    next.send();
    await replyPrivateCalendar(next.i, payload, 20 * 60_000);
    expect(old.mock.deleteReply).not.toHaveBeenCalled();
  });
});
