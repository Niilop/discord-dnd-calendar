import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  type MessageActionRowComponentBuilder,
  type MessageMentionOptions,
} from "discord.js";
import type { DayAvailability } from "../../domain/availability.js";
import { colorEmoji } from "../../domain/color.js";
import {
  addMonths,
  formatDayShort,
  formatMonth,
  localDatesToUtcRange,
  localDateOf,
  localTimeOf,
  offsetLabel,
  timezoneName,
} from "../../domain/time.js";
import type { AvailabilityStatus, AvailabilityValue, Campaign, LocalDate, YearMonth } from "../../domain/types.js";
import type { CalendarMonthView, CalendarSession } from "../../services/calendarService.js";
import { encodeCustomId, type CalendarMode, type CalendarState } from "../customIds.js";
import type { ImageDay } from "./calendarImage.js";
import { CALENDAR_IMAGE_NAME, renderCalendarPng } from "./calendarPng.js";
import { datesInMask, dayMenuRows, type DayOption } from "./dayMenu.js";
import { truncate } from "./format.js";
import { sessionLabel } from "./rsvpCard.js";
import { renderSessionControls, type SessionPanelView } from "./sessionPanel.js";

/**
 * Bump when the calendar message changes in a way Discord can't edit in place
 * (the publisher then re-posts it). 3 = server-wide calendar, components v2 + image.
 */
export const CALENDAR_LAYOUT = 3;

/** A components-v2 message: everything lives in `components`, images are attachments. */
export interface V2Payload {
  components: (ContainerBuilder | TextDisplayBuilder | ActionRowBuilder<MessageActionRowComponentBuilder>)[];
  files: AttachmentBuilder[];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions?: MessageMentionOptions;
}

/** Reply privately with a v2 payload. */
export function asEphemeral(payload: V2Payload) {
  return { ...payload, flags: [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2] as const };
}

/** Edit a v2 message in place, replacing (not adding to) its image. */
export function asEdit(payload: V2Payload) {
  return { ...payload, attachments: [] };
}

export function toImageDays(view: CalendarMonthView, picked: ReadonlySet<LocalDate> = new Set()): Map<LocalDate, ImageDay> {
  const days = new Map<LocalDate, ImageDay>();
  for (const date of view.days) {
    const availability = view.availability.get(date);
    days.set(date, {
      sessions: [],
      unavailable: availability?.unavailable.length ?? 0,
      preferNot: availability?.preferNot.length ?? 0,
      ...(picked.has(date) ? { picked: true } : {}),
    });
  }
  for (const s of view.sessions) {
    days.get(s.localDate)?.sessions.push({
      time: localTimeOf(s.session.startsAt, view.settings.timezone),
      label: s.campaign.name,
      color: s.campaign.color,
      status: s.session.status,
    });
  }
  return days;
}

/** "**Thu 1 Oct** — @Alice can't · @Bob unsure", one line per upcoming day with marks. */
export function unavailabilityLines(view: CalendarMonthView): string[] {
  return view.days
    .filter((date) => date >= view.today)
    .flatMap((date) => {
      const day = view.availability.get(date);
      if (!day || (!day.unavailable.length && !day.preferNot.length)) return [];
      const who = [...day.unavailable.map((id) => `<@${id}> can't`), ...day.preferNot.map((id) => `<@${id}> unsure`)];
      return [`**${formatDayShort(date)}** — ${who.join(" · ")}`];
    });
}

/** What a private calendar shows under the picture, besides browsing. */
export type CalendarPanel =
  | { mode: "avail"; marks: Map<LocalDate, AvailabilityStatus> }
  | { mode: "add"; campaigns: Campaign[]; campaign: Campaign; availability: Map<LocalDate, DayAvailability> }
  | { mode: "edit"; sessions: CalendarSession[]; selected?: SessionPanelView };

export interface PrivateCalendar {
  /** Omitted when just browsing. */
  panel?: CalendarPanel;
  /** Days picked in the day menu: bit (day - 1). */
  mask: number;
  notice?: string;
}

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
const row = (...components: MessageActionRowComponentBuilder[]): Row =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(components);

const MODES: { mode: Exclude<CalendarMode, "view">; label: string; emoji: string }[] = [
  { mode: "avail", label: "My Availability", emoji: "📅" },
  { mode: "add", label: "Add sessions", emoji: "➕" },
  { mode: "edit", label: "Edit sessions", emoji: "✏️" },
];

function stateOf(view: CalendarMonthView, priv?: PrivateCalendar): CalendarState {
  const panel = priv?.panel;
  return {
    mode: panel?.mode ?? "view",
    month: view.month,
    campaignId: panel?.mode === "add" ? panel.campaign.id : 0,
    mask: priv?.mask ?? 0,
    sessionId: panel?.mode === "edit" ? (panel.selected?.overview.session.id ?? 0) : 0,
  };
}

/**
 * Month buttons, then the three modes. Every button on the shared message
 * opens a private copy of the calendar; in the copy they redraw it in place,
 * and changing month keeps the mode.
 */
export function renderCalendarControls(view: CalendarMonthView, priv?: PrivateCalendar): Row[] {
  const state = stateOf(view, priv);
  const go = (month: YearMonth) => encodeCustomId({ kind: "cv", ...state, month, mask: 0, sessionId: 0 });
  const prev = addMonths(view.month, -1);
  const next = addMonths(view.month, 1);
  return [
    row(
      new ButtonBuilder().setCustomId(go(prev)).setLabel(`◀ ${formatMonth(prev).split(" ")[0]}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(go(next)).setLabel(`${formatMonth(next).split(" ")[0]} ▶`).setStyle(ButtonStyle.Secondary),
    ),
    row(
      ...MODES.map((m) =>
        new ButtonBuilder()
          .setCustomId(encodeCustomId({ kind: "cv", mode: m.mode, month: view.month, campaignId: state.campaignId, mask: 0, sessionId: 0 }))
          .setLabel(m.label)
          .setEmoji(m.emoji)
          .setStyle(state.mode === m.mode ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(state.mode === m.mode),
      ),
    ),
  ];
}

const MARK: Record<AvailabilityStatus, { emoji: string; text: string }> = {
  unavailable: { emoji: "🚫", text: "can't play" },
  prefer_not: { emoji: "❔", text: "unsure" },
};

const MARK_BUTTONS: { status: AvailabilityValue; label: string; emoji?: string; style: ButtonStyle }[] = [
  { status: "unavailable", label: "Can't play", emoji: "🚫", style: ButtonStyle.Danger },
  { status: "prefer_not", label: "Unsure", emoji: "❔", style: ButtonStyle.Primary },
  { status: "unspecified", label: "Clear", style: ButtonStyle.Secondary },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The section under the mode buttons: a heading, what to do next, and the controls for this month. */
function renderPanel(view: CalendarMonthView, priv: PrivateCalendar & { panel: CalendarPanel }): { text: string; rows: Row[] } {
  const { panel } = priv;
  const state = stateOf(view, priv);
  const month = formatMonth(view.month);
  const upcoming = view.days.filter((d) => d >= view.today);
  const picked = datesInMask(view.month, priv.mask).filter((d) => d >= view.today);
  const done = new ButtonBuilder()
    .setCustomId(encodeCustomId({ kind: "cv", ...state, mode: "view", mask: 0, sessionId: 0 }))
    .setLabel("Done")
    .setStyle(ButtonStyle.Secondary);
  const notice = priv.notice ?? null;
  const pickMenus = (options: DayOption[], placeholder: string) =>
    dayMenuRows(options, priv.mask, (from, to) => encodeCustomId({ kind: "cv.pick", ...state, from, to }), placeholder);
  const sessionsOn = (date: LocalDate) =>
    view.sessions
      .filter((s) => s.localDate === date && s.session.status !== "cancelled")
      .map((s) => `${s.campaign.name} ${localTimeOf(s.session.startsAt, view.settings.timezone)}`);
  const over = `This month is over — press **${formatMonth(addMonths(view.month, 1)).split(" ")[0]} ▶** to go on.`;

  if (panel.mode === "avail") {
    const options = upcoming.map((date): DayOption => {
      const mark = panel.marks.get(date);
      const description = [mark ? `You: ${MARK[mark].text}` : null, ...sessionsOn(date)].filter((p) => p !== null).join(" · ");
      return { date, label: formatDayShort(date), ...(description ? { description } : {}), ...(mark ? { emoji: MARK[mark].emoji } : {}) };
    });
    const text = [
      `### 📅 My Availability — ${month}`,
      !upcoming.length
        ? over
        : picked.length
          ? `**Picked ${plural(picked.length, "day")}** (green on the calendar). Now press **Can't play**, **Unsure** or **Clear**.`
          : "Pick days in the menu, then press **Can't play** or **Unsure**. To remove a mark, pick the day and press **Clear**.",
      notice,
      "-# Unmarked days don't count either way · applies to every campaign",
    ];
    const buttons = MARK_BUTTONS.map((b) => {
      const button = new ButtonBuilder()
        .setCustomId(encodeCustomId({ kind: "cv.mark", month: view.month, mask: priv.mask, status: b.status }))
        .setLabel(b.label)
        .setStyle(b.style)
        .setDisabled(!picked.length);
      return b.emoji ? button.setEmoji(b.emoji) : button;
    });
    return {
      text: text.filter((l) => l !== null).join("\n"),
      rows: [...pickMenus(options, "Pick days…"), upcoming.length ? row(...buttons, done) : row(done)],
    };
  }

  if (panel.mode === "add") {
    const { campaign } = panel;
    const options = upcoming.map((date): DayOption => {
      const day = panel.availability.get(date);
      const hints = [
        ...sessionsOn(date),
        day?.unavailable.length ? `${day.unavailable.length} can't` : null,
        day?.preferNot.length ? `${day.preferNot.length} unsure` : null,
      ].filter((h) => h !== null);
      return {
        date,
        label: formatDayShort(date),
        ...(hints.length ? { description: hints.join(" · ") } : {}),
        ...(day?.unavailable.length ? { emoji: "⚠️" } : {}),
      };
    });
    const text = [
      `### ➕ Add sessions — ${month} · ${colorEmoji(campaign.color)} ${campaign.name}`,
      !upcoming.length
        ? over
        : picked.length
          ? `**Picked ${plural(picked.length, "day")}** (green on the calendar). Press **Create** to choose the start time.`
          : "Pick the days to play in the menu, then press **Create**. Days marked ⚠️ have players who can't make it.",
      notice,
    ];
    const rows: Row[] = [];
    if (panel.campaigns.length > 1) {
      rows.push(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(encodeCustomId({ kind: "cv.camp", month: view.month, mask: priv.mask }))
            .addOptions(
              panel.campaigns.slice(0, 25).map((c) => ({
                label: truncate(c.name, 100),
                value: String(c.id),
                emoji: colorEmoji(c.color),
                default: c.id === campaign.id,
              })),
            ),
        ),
      );
    }
    rows.push(...pickMenus(options, "Pick the days to play…"));
    const create = new ButtonBuilder()
      .setCustomId(encodeCustomId({ kind: "bk.go", campaignId: campaign.id, month: view.month, mask: priv.mask }))
      .setLabel(picked.length ? `Create ${plural(picked.length, "session")}` : "Create")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!picked.length);
    rows.push(upcoming.length ? row(create, done) : row(done));
    return { text: text.filter((l) => l !== null).join("\n"), rows };
  }

  const { selected } = panel;
  const text = [
    `### ✏️ Edit sessions — ${month}`,
    selected
      ? null
      : panel.sessions.length
        ? "Pick a session to move it to another campaign, change its date and time, or cancel it."
        : "No upcoming sessions you can edit this month. Use ◀ ▶ to look at other months.",
    notice,
  ];
  const rows: Row[] = [];
  if (panel.sessions.length) {
    rows.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(encodeCustomId({ kind: "cv.edit" }))
          .setPlaceholder("Pick a session…")
          .addOptions(
            panel.sessions.slice(0, 25).map((s) => ({
              label: truncate(`${formatDayShort(s.localDate)} ${localTimeOf(s.session.startsAt, view.settings.timezone)} — ${s.campaign.name}`, 100),
              value: String(s.session.id),
              description: truncate(sessionLabel(s.session), 100),
              emoji: colorEmoji(s.campaign.color),
              default: s.session.id === selected?.overview.session.id,
            })),
          ),
      ),
    );
  }
  if (selected) {
    const controls = renderSessionControls(selected);
    text.push(controls.text);
    rows.push(...controls.rows);
  }
  rows.push(row(done));
  return { text: text.filter((l) => l !== null).join("\n"), rows };
}

/** "Central European Time · UTC+2" or just "UTC+2", as in effect today. */
function zoneSubtitle(tz: string, today: string): string {
  const offset = offsetLabel(localDatesToUtcRange(today, today, tz).start, tz);
  const name = timezoneName(tz);
  return name === offset ? offset : `${name} · ${offset}`;
}

/**
 * The shared calendar (no `priv`), or someone's private copy of it: the same
 * picture and buttons, plus the panel for the mode they're in.
 */
export function renderCalendarMessage(view: CalendarMonthView, priv?: PrivateCalendar): V2Payload {
  const panel = priv?.panel;
  const selected = panel?.mode === "edit" ? panel.selected?.overview : undefined;
  const picked = !panel
    ? undefined
    : panel.mode === "edit"
      ? new Set(selected ? [localDateOf(selected.session.startsAt, view.settings.timezone)] : [])
      : new Set(datesInMask(view.month, priv.mask));
  const png = renderCalendarPng({
    month: view.month,
    today: view.today,
    subtitle: zoneSubtitle(view.settings.timezone, view.today),
    days: toImageDays(view, picked),
    legend: view.campaigns.map((c) => ({ name: c.name, color: c.color })),
  });

  const lines = unavailabilityLines(view);
  const text = lines.length ? lines.join("\n") : "-# Nobody has marked days they can't play this month.";

  const container = new ContainerBuilder()
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(`attachment://${CALENDAR_IMAGE_NAME}`)
          .setDescription(`Session calendar for ${formatMonth(view.month)}`),
      ),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(text, 4000)))
    .addActionRowComponents(...renderCalendarControls(view, priv));

  if (priv?.panel) {
    const panel = renderPanel(view, { ...priv, panel: priv.panel });
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(panel.text, 4000)))
      .addActionRowComponents(...panel.rows);
  }

  return {
    components: [container],
    files: [new AttachmentBuilder(png, { name: CALENDAR_IMAGE_NAME })],
    flags: MessageFlags.IsComponentsV2,
    // Names render as mentions but nobody gets pinged.
    allowedMentions: { parse: [] },
  };
}
