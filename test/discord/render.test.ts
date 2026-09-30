import { describe, expect, it } from "vitest";
import { commands } from "../../src/discord/commands/index.js";
import { autocompleteTimezone } from "../../src/discord/commands/shared.js";
import { parseCustomId } from "../../src/discord/customIds.js";
import { renderCalendarControls, renderCalendarMessage, toImageDays, type V2Payload } from "../../src/discord/render/calendar.js";
import { renderCalendarSvg } from "../../src/discord/render/calendarImage.js";
import { applyPick, datesInMask, maskOf } from "../../src/discord/render/dayMenu.js";
import type { CalendarState } from "../../src/discord/customIds.js";
import { renderRsvpCard } from "../../src/discord/render/rsvpCard.js";
import { renderSessionControls } from "../../src/discord/render/sessionPanel.js";
import { summarizeAvailability } from "../../src/domain/availability.js";
import { daysInMonth } from "../../src/domain/time.js";
import type { Campaign, GuildSettings, Session } from "../../src/domain/types.js";
import type { CalendarMonthView } from "../../src/services/calendarService.js";


const settings: GuildSettings = {
  guildId: "10",
  timezone: "Europe/Helsinki",
  calendarChannelId: "20",
  calendarMessageChannelId: null,
  calendarMessageId: null,
  calendarMessageMonth: null,
  calendarMessageLayout: 0,
};

const campaign = (id: number, name: string, color: string): Campaign => ({
  id,
  guildId: "10",
  name,
  timezone: "Europe/Helsinki",
  rsvpChannelId: null,
  currentSession: 4,
  reminderMinutes: 2880,
  reminderPings: false,
  color,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const strahd = campaign(1, "Curse of Strahd", "#e5484d");
const waterdeep = campaign(2, "Waterdeep", "#12a594");

const session = (id: number, c: Campaign, startsAt: string): Session => ({
  id,
  campaignId: c.id,
  title: null,
  number: id,
  startsAt: new Date(startsAt),
  endsAt: new Date(new Date(startsAt).getTime() + 4 * 3_600_000),
  notes: null,
  createdBy: "1",
  status: "scheduled",
  scheduleChangedAt: new Date(0),
  discordChannelId: null,
  discordMessageId: null,
  cardStartsAt: null,
  previousStartsAt: null,
  cancelReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const counts = { attending: 2, maybe: 1, absent: 0, noResponse: 1 };
const days = daysInMonth("2026-10");
const availability = summarizeAvailability(days, ["a", "b", "c", "d", "e"], [
  { guildId: "10", userId: "a", date: "2026-10-17", status: "unavailable" },
  { guildId: "10", userId: "c", date: "2026-10-17", status: "prefer_not" },
  { guildId: "10", userId: "c", date: "2026-10-20", status: "prefer_not" },
]);
const view: CalendarMonthView = {
  settings,
  month: "2026-10",
  today: "2026-10-01",
  days,
  memberCount: 5,
  campaigns: [strahd, waterdeep],
  sessions: [
    { session: session(5, strahd, "2026-10-17T10:00:00Z"), campaign: strahd, localDate: "2026-10-17", counts },
    { session: session(6, waterdeep, "2026-10-17T16:00:00Z"), campaign: waterdeep, localDate: "2026-10-17", counts },
  ],
  availability,
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

type Option = { label: string; value: string; description?: string; default?: boolean; emoji?: { name: string } };
type Json = {
  type: number;
  content?: string;
  components?: Json[];
  custom_id?: string;
  label?: string;
  style?: number;
  disabled?: boolean;
  options?: Option[];
  max_values?: number;
};
const toJson = (payload: V2Payload) => payload.components.map((c) => c.toJSON() as Json);
/** Every component, nested ones included (Discord allows 40 per message). */
const countComponents = (list: Json[]): number => list.reduce((n, c) => n + 1 + countComponents(c.components ?? []), 0);
/** Every button / select, in order, including those inside containers. */
const controls = (list: Json[]): Json[] =>
  list.flatMap((c) => (c.type === 1 ? (c.components ?? []) : c.components ? controls(c.components) : []));
const menus = (list: Json[]) => controls(list).filter((c) => c.type === 3);
const buttons = (list: Json[]) => controls(list).filter((c) => c.type === 2);

describe("slash command definitions", () => {
  it("serialize without validation errors", () => {
    expect(commands.map((c) => c.toJSON().name)).toEqual(["campaign", "session", "availability", "calendar"]);
  });
});

describe("calendar image", () => {
  const svg = renderCalendarSvg({
    month: "2026-10",
    today: "2026-10-05",
    subtitle: "Europe/Helsinki",
    days: toImageDays(view),
    legend: view.campaigns.map((c) => ({ name: c.name, color: c.color })),
  });

  it("colors session days by campaign and splits a day shared by two campaigns", () => {
    expect(svg).toMatch(/height="66" fill="#e5484d"\/><text [^>]*>13:00<\/text>/);
    expect(svg).toMatch(/height="66" fill="#12a594"\/><text [^>]*>19:00<\/text>/);
  });

  it("keeps availability to a tiny marker and lists campaigns in the legend", () => {
    expect(svg).toMatch(/<circle [^>]*r="5" fill="#e5484d"\/><text [^>]*>1<\/text>/);
    expect(svg).toContain(">Curse of Strahd</text>");
    expect(svg).toContain(">Unsure</text>");
  });
});

describe("calendar message", () => {
  const payload = renderCalendarMessage(view);
  const json = JSON.stringify(toJson(payload));

  it("shows the image and, under it, only who can't play or is unsure", () => {
    expect((payload.files[0]!.attachment as Buffer).subarray(0, 4)).toEqual(PNG_SIGNATURE);
    expect(json).toContain("attachment://calendar.png");
    expect(json).toContain("**Sat 17 Oct** — <@a> can't · <@c> unsure");
    expect(json).toContain("**Tue 20 Oct** — <@c> unsure");
    expect(json).not.toContain("✅"); // no session list / RSVP counts
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("has month buttons and the three modes, all opening a private calendar — no menus", () => {
    const rows = renderCalendarControls(view).map((r) => r.toJSON());
    expect(rows.map((r) => r.components.map((c) => ("label" in c ? c.label : "")))).toEqual([
      ["◀ September", "November ▶"],
      ["My Availability", "Add sessions", "Edit sessions"],
    ]);
    const ids = rows.flatMap((r) => r.components.map((c) => parseCustomId((c as { custom_id: string }).custom_id)));
    expect(ids).toEqual([
      { kind: "cv", mode: "view", month: "2026-09", campaignId: 0, mask: 0, sessionId: 0 },
      { kind: "cv", mode: "view", month: "2026-11", campaignId: 0, mask: 0, sessionId: 0 },
      { kind: "cv", mode: "avail", month: "2026-10", campaignId: 0, mask: 0, sessionId: 0 },
      { kind: "cv", mode: "add", month: "2026-10", campaignId: 0, mask: 0, sessionId: 0 },
      { kind: "cv", mode: "edit", month: "2026-10", campaignId: 0, mask: 0, sessionId: 0 },
    ]);
    expect(menus(toJson(payload))).toHaveLength(0);
  });
});

/** Every component's custom ID, parsed. */
const ids = (json: Json[]) => controls(json).map((c) => parseCustomId(c.custom_id!));
const later = { ...view, today: "2026-10-10" };

describe("private calendar: my availability", () => {
  const priv = (mask: number) =>
    renderCalendarMessage(later, {
      panel: { mode: "avail", marks: new Map([["2026-10-12", "unavailable"], ["2026-10-13", "prefer_not"]] as const) },
      mask,
    });
  const json = toJson(priv(maskOf(["2026-10-12", "2026-10-14"])));

  it("keeps the mode when changing month and highlights the active mode", () => {
    const [prev, next, avail] = buttons(json);
    expect(parseCustomId(next!.custom_id!)).toEqual({ kind: "cv", mode: "avail", month: "2026-11", campaignId: 0, mask: 0, sessionId: 0 });
    expect(parseCustomId(prev!.custom_id!)).toMatchObject({ mode: "avail", month: "2026-09" });
    expect(avail).toMatchObject({ label: "My Availability", disabled: true });
  });

  it("offers this month's upcoming days in one menu, with the viewer's marks and sessions", () => {
    const [menu] = menus(json);
    expect(menu!.options).toHaveLength(22);
    const byLabel = new Map(menu!.options!.map((o) => [o.label, o]));
    expect(byLabel.get("Mon 12 Oct")).toMatchObject({ description: "You: can't play", default: true, emoji: { name: "🚫" } });
    expect(byLabel.get("Tue 13 Oct")).toMatchObject({ description: "You: unsure", default: false });
    expect(byLabel.get("Sat 17 Oct")!.description).toBe("Curse of Strahd 13:00 · Waterdeep 19:00");
    expect(countComponents(json)).toBeLessThanOrEqual(40);
  });

  it("shows picked days on the picture and applies them with the mark buttons", () => {
    const svg = renderCalendarSvg({
      month: "2026-10",
      today: "2026-10-10",
      subtitle: "",
      days: toImageDays(later, new Set(["2026-10-12"])),
      legend: [],
    });
    expect(svg).toMatch(/stroke="#3dd68c" stroke-width="6"/); // outline
    expect(svg).toMatch(/<circle [^>]*fill="#3dd68c"\/><path /); // check mark
    const mark = buttons(json).find((b) => b.label === "Unsure")!;
    const id = parseCustomId(mark.custom_id!) as { month: string; mask: number; status: string };
    expect(id.status).toBe("prefer_not");
    expect(datesInMask(id.month, id.mask)).toEqual(["2026-10-12", "2026-10-14"]);
    expect(buttons(toJson(priv(0))).find((b) => b.label === "Can't play")!.disabled).toBe(true);
    expect(ids(json)).toContainEqual({ kind: "cv", mode: "view", month: "2026-10", campaignId: 0, mask: 0, sessionId: 0 }); // Done
  });

  it("splits a full future month into two menus (Discord caps a menu at 25 options)", () => {
    const full = toJson(renderCalendarMessage(view, { panel: { mode: "avail", marks: new Map() }, mask: 0 }));
    expect(menus(full).map((m) => m.options!.length)).toEqual([15, 16]);
    expect(menus(full).map((m) => parseCustomId(m.custom_id!))).toMatchObject([
      { from: 1, to: 15 },
      { from: 16, to: 31 },
    ]);
  });

  it("points to next month when this one is over", () => {
    const over = toJson(renderCalendarMessage({ ...view, today: "2026-11-02" }, { panel: { mode: "avail", marks: new Map() }, mask: 0 }));
    expect(menus(over)).toHaveLength(0);
    expect(JSON.stringify(over)).toContain("November ▶** to go on");
  });

  it("picking in one menu keeps the picks from the other", () => {
    const mask = maskOf(["2026-10-03", "2026-10-20"]);
    expect(datesInMask("2026-10", applyPick(mask, 16, 31, [25]))).toEqual(["2026-10-03", "2026-10-25"]);
    expect(datesInMask("2026-10", applyPick(mask, 1, 15, []))).toEqual(["2026-10-20"]);
  });
});

describe("private calendar: add sessions", () => {
  const json = toJson(
    renderCalendarMessage(later, {
      panel: { mode: "add", campaigns: [strahd, waterdeep], campaign: strahd, availability },
      mask: maskOf(["2026-10-16", "2026-10-23"]),
    }),
  );

  it("has a campaign menu, the day menu and Create", () => {
    const [campaignMenu, dayMenu] = menus(json);
    expect(campaignMenu!.options!.find((o) => o.default)!.label).toBe("Curse of Strahd");
    expect(parseCustomId(campaignMenu!.custom_id!)).toEqual({ kind: "cv.camp", month: "2026-10", mask: maskOf(["2026-10-16", "2026-10-23"]) });
    expect(dayMenu!.options).toHaveLength(22);
    expect(buttons(json).slice(-2).map((b) => b.label)).toEqual(["Create 2 sessions", "Done"]);
    const create = parseCustomId(buttons(json).at(-2)!.custom_id!) as { campaignId: number; month: string; mask: number };
    expect(create.campaignId).toBe(1);
    expect(datesInMask(create.month, create.mask)).toEqual(["2026-10-16", "2026-10-23"]);
  });

  it("shows other sessions and players' marks on each day", () => {
    const sat = menus(json)[1]!.options!.find((o) => o.label === "Sat 17 Oct")!;
    expect(sat.description).toBe("Curse of Strahd 13:00 · Waterdeep 19:00 · 1 can't · 1 unsure");
    expect(sat.emoji).toMatchObject({ name: "⚠️" });
    expect(menus(json)[1]!.options!.find((o) => o.label === "Fri 16 Oct")!.default).toBe(true);
  });

  it("picking days keeps the campaign in the state", () => {
    const pick = parseCustomId(menus(json)[1]!.custom_id!) as CalendarState;
    expect(pick).toMatchObject({ mode: "add", campaignId: 1, month: "2026-10" });
  });
});

describe("private calendar: edit sessions", () => {
  const overview = {
    session: view.sessions[0]!.session,
    campaign: strahd,
    members: [],
    rsvps: [],
    groups: { attending: ["1"], maybe: [], absent: [], noResponse: ["2"] },
  };

  it("lists the month's editable sessions in one menu", () => {
    const json = toJson(renderCalendarMessage(later, { panel: { mode: "edit", sessions: view.sessions }, mask: 0 }));
    const [menu] = menus(json);
    expect(menu!.options!.map((o) => o.value)).toEqual(["5", "6"]);
    expect(parseCustomId(menu!.custom_id!)).toEqual({ kind: "cv.edit" });
    const none = JSON.stringify(toJson(renderCalendarMessage(later, { panel: { mode: "edit", sessions: [] }, mask: 0 })));
    expect(none).toContain("No upcoming sessions you can edit this month");
  });

  it("edits the picked session right under the calendar", () => {
    const payload = renderCalendarMessage(later, {
      panel: { mode: "edit", sessions: view.sessions, selected: { overview, campaigns: [strahd, waterdeep], notice: "✅ Saved." } },
      mask: 0,
    });
    const json = toJson(payload);
    expect(json).toHaveLength(1); // one message: the calendar
    expect(JSON.stringify(json)).toContain("attachment://calendar.png");
    const [sessionMenu, campaignMenu] = menus(json);
    expect(sessionMenu!.options!.find((o) => o.default)!.value).toBe("5");
    expect(campaignMenu!.options!.find((o) => o.default)!.label).toBe("Campaign: Curse of Strahd");
    expect(buttons(json).slice(-3).map((b) => b.label)).toEqual(["Change date & time", "Cancel session", "Done"]);
    const text = JSON.stringify(json);
    expect(text).toContain("Curse of Strahd — Session 5");
    expect(text).toContain("✅ Saved.");
    // Month buttons and mode buttons drop the picked session.
    expect(ids(json).filter((id) => id?.kind === "cv").every((id) => (id as CalendarState).sessionId === 0)).toBe(true);
  });

  it("shows the picked session's day on the picture", () => {
    const svg = renderCalendarSvg({ month: "2026-10", today: "2026-10-10", subtitle: "", days: toImageDays(later, new Set(["2026-10-17"])), legend: [] });
    expect(svg).toMatch(/stroke="#3dd68c" stroke-width="6"/);
  });

  it("asks before cancelling", () => {
    const { text, rows } = renderSessionControls({ overview, campaigns: [strahd], confirmingCancel: true });
    expect(text).toContain("**Cancel this session?**");
    expect(rows.flatMap((r) => r.toJSON().components.map((c) => ("label" in c ? c.label : "")))).toEqual(["Yes, cancel it", "Keep it"]);
  });
});

describe("RSVP card", () => {
  it("uses the campaign color and drops buttons once cancelled", () => {
    const overview = {
      session: view.sessions[0]!.session,
      campaign: strahd,
      members: [],
      rsvps: [],
      groups: { attending: [], maybe: [], absent: [], noResponse: [] },
    };
    expect(renderRsvpCard(overview).embeds[0]!.toJSON().color).toBe(0xe5484d);
    expect(renderRsvpCard({ ...overview, session: { ...overview.session, status: "cancelled" } }).components).toEqual([]);
  });
});

describe("timezone suggestions", () => {
  const summer = new Date("2026-10-01T12:00:00Z");
  it("offers regions with their current offset, then whole-hour offsets", () => {
    const all = autocompleteTimezone("", summer).map((c) => c.name);
    expect(all).toContain("Central European Time (UTC+2 now)");
    expect(all.some((n) => n.includes("/"))).toBe(false); // no city names
    expect(autocompleteTimezone("+2", summer).map((c) => c.value)).toEqual(["Central European Time", "UTC+2"]);
    expect(autocompleteTimezone("utc+1", summer).map((c) => c.value)).toEqual(["Western European Time", "UTC+1"]);
    expect(autocompleteTimezone("central", new Date("2026-12-01T12:00:00Z"))[0]!.name).toBe("Central European Time (UTC+1 now)");
  });
});
