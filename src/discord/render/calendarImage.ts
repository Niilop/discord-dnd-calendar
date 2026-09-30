import { textColorOn } from "../../domain/color.js";
import { daysInMonth, formatMonth, weekdayOf } from "../../domain/time.js";
import type { LocalDate, SessionStatus, YearMonth } from "../../domain/types.js";

/**
 * Draws the server calendar month as SVG. Pure string building so it is fast
 * and testable; rasterizing to PNG happens in calendarPng.ts.
 *
 * A day with a session is filled with that campaign's color. Two sessions on
 * one day split the cell into two colored halves. Availability is only a tiny
 * marker in the corner — it never colors the day. Days picked in a private
 * calendar's menu get a green outline and a check mark.
 */

export interface ImageSession {
  time: string;
  /** Usually the campaign name. */
  label: string;
  /** '#rrggbb' of the session's campaign. */
  color: string;
  status: SessionStatus;
}

export interface ImageDay {
  sessions: ImageSession[];
  unavailable: number;
  preferNot: number;
  /** Picked in the day menu of a private calendar. */
  picked?: boolean;
}

export interface CalendarImageModel {
  month: YearMonth;
  today: LocalDate;
  subtitle: string;
  days: ReadonlyMap<LocalDate, ImageDay>;
  legend: { name: string; color: string }[];
}

// Rendered fairly narrow so text stays legible when Discord scales the image down.
export const IMAGE_WIDTH = 1120;

const THEME = {
  bg: "#1e1f22",
  cell: "#2b2d31",
  text: "#f2f3f5",
  muted: "#949ba4",
  unavailable: "#e5484d",
  preferNot: "#ffb224",
  today: "#f2f3f5",
  picked: "#3dd68c",
  ink: "#111113",
} as const;

const PAD = 28;
const GAP = 8;
const CELL_W = (IMAGE_WIDTH - PAD * 2 - GAP * 6) / 7;
const CELL_H = 132;
const HEADER_H = 96;
const WEEKDAY_H = 40;
const LEGEND_LINE_H = 40;
const RADIUS = 14;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rough fit for Inter at the given size (there is no text measurement when building SVG strings). */
function fit(value: string, fontSize: number, maxWidth: number): string {
  const maxChars = Math.floor(maxWidth / (fontSize * 0.56));
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

const textWidth = (value: string, fontSize: number) => value.length * fontSize * 0.56;

interface TextOpts {
  size: number;
  fill: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
}

function text(x: number, y: number, content: string, opts: TextOpts): string {
  const anchor = opts.anchor ? ` text-anchor="${opts.anchor}"` : "";
  return `<text x="${x}" y="${y}" font-size="${opts.size}" fill="${opts.fill}" font-weight="${opts.weight ?? 400}"${anchor}>${esc(content)}</text>`;
}

/** Tiny "● 2 ● 1" marker in the top-right corner, on a small dark pill so it reads on any color. */
function availabilityMarker(right: number, top: number, unavailable: number, preferNot: number): string {
  const items = [
    ...(unavailable ? [{ fill: THEME.unavailable, n: unavailable }] : []),
    ...(preferNot ? [{ fill: THEME.preferNot, n: preferNot }] : []),
  ];
  if (!items.length) return "";
  const itemW = 30;
  const w = items.length * itemW + 6;
  const left = right - w;
  const cy = top + 12;
  let out = `<rect x="${left}" y="${top}" width="${w}" height="24" rx="12" fill="${THEME.ink}" fill-opacity="0.7"/>`;
  items.forEach((item, i) => {
    const cx = left + 12 + i * itemW;
    out += `<circle cx="${cx}" cy="${cy}" r="5" fill="${item.fill}"/>`;
    out += text(cx + 8, cy + 5, String(item.n), { size: 14, fill: THEME.text, weight: 700 });
  });
  return out;
}

function dayCell(date: LocalDate, day: ImageDay | undefined, x: number, y: number, isToday: boolean): string {
  const active = (day?.sessions ?? []).filter((s) => s.status !== "cancelled");
  const parts: string[] = [`<clipPath id="c${date}"><rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" rx="${RADIUS}"/></clipPath>`];
  parts.push(`<g clip-path="url(#c${date})"><rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" fill="${THEME.cell}"/>`);

  // Session bands: one fills the cell, two split it, more show "+N".
  const shown = active.length > 2 ? [active[0]!] : active;
  const bandH = shown.length ? CELL_H / (shown.length + (active.length > 2 ? 1 : 0)) : 0;
  shown.forEach((s, i) => {
    const top = y + i * bandH;
    const fg = textColorOn(s.color);
    const opacity = s.status === "completed" ? ' opacity="0.75"' : "";
    parts.push(`<g${opacity}><rect x="${x}" y="${top}" width="${CELL_W}" height="${bandH}" fill="${s.color}"/>`);
    if (shown.length === 1 && active.length === 1) {
      parts.push(text(x + 12, top + 70, s.time, { size: 24, fill: fg, weight: 700 }));
      parts.push(text(x + 12, top + 96, fit(s.label, 19, CELL_W - 24), { size: 19, fill: fg }));
    } else {
      // Split days are too narrow for names; the color says which campaign it is.
      const baseline = i === 0 ? top + bandH - 12 : top + bandH / 2 + 8;
      parts.push(text(x + 12, baseline, s.time, { size: 20, fill: fg, weight: 700 }));
    }
    parts.push("</g>");
  });
  if (active.length > 2) {
    const top = y + bandH;
    parts.push(`<rect x="${x}" y="${top}" width="${CELL_W}" height="${CELL_H - bandH}" fill="${THEME.ink}" fill-opacity="0.5"/>`);
    parts.push(text(x + 12, top + (CELL_H - bandH) / 2 + 7, `+${active.length - 1} more`, { size: 17, fill: THEME.text, weight: 700 }));
  }
  parts.push("</g>");

  const numberColor = shown.length ? textColorOn(shown[0]!.color) : THEME.text;
  parts.push(text(x + 12, y + 32, String(Number(date.slice(8))), { size: 26, fill: numberColor, weight: 700 }));
  if (day) parts.push(availabilityMarker(x + CELL_W - 6, y + 8, day.unavailable, day.preferNot));
  if (isToday) {
    parts.push(
      `<rect x="${x + 2}" y="${y + 2}" width="${CELL_W - 4}" height="${CELL_H - 4}" rx="${RADIUS - 2}" fill="none" stroke="${THEME.today}" stroke-width="4"/>`,
    );
  }
  if (day?.picked) {
    const inset = isToday ? 8 : 3;
    parts.push(
      `<rect x="${x + inset}" y="${y + inset}" width="${CELL_W - inset * 2}" height="${CELL_H - inset * 2}" rx="${RADIUS - inset}" fill="none" stroke="${THEME.picked}" stroke-width="6"/>`,
    );
    const cx = x + CELL_W - 26;
    const cy = y + CELL_H - 26;
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="16" fill="${THEME.picked}"/>`,
      `<path d="M${cx - 7} ${cy} l5 5 l9 -10" fill="none" stroke="${THEME.ink}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }
  return parts.join("");
}

/** Legend items laid out in lines that fit the image width. */
function layoutLegend(model: CalendarImageModel): { swatch: string; label: string; x: number; line: number }[] {
  const items = [
    ...model.legend.map((c) => ({ swatch: `<rect width="24" height="24" rx="6" fill="${c.color}"/>`, label: c.name })),
    { swatch: `<circle cx="12" cy="12" r="6" fill="${THEME.unavailable}"/>`, label: "Unavailable" },
    { swatch: `<circle cx="12" cy="12" r="6" fill="${THEME.preferNot}"/>`, label: "Unsure" },
  ];
  let x = PAD;
  let line = 0;
  return items.map((item) => {
    const label = fit(item.label, 20, 300);
    const width = 36 + textWidth(label, 20) + 28;
    if (x + width > IMAGE_WIDTH - PAD && x > PAD) {
      x = PAD;
      line += 1;
    }
    const placed = { swatch: item.swatch, label, x, line };
    x += width;
    return placed;
  });
}

export function renderCalendarSvg(model: CalendarImageModel): string {
  const days = daysInMonth(model.month);
  const offset = weekdayOf(days[0]!) - 1;
  const rows = Math.ceil((offset + days.length) / 7);
  const gridTop = HEADER_H + WEEKDAY_H;
  const gridBottom = gridTop + rows * CELL_H + (rows - 1) * GAP;
  const legend = layoutLegend(model);
  const legendLines = (legend.at(-1)?.line ?? 0) + 1;
  const height = gridBottom + 24 + legendLines * LEGEND_LINE_H + PAD - 8;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${height}" viewBox="0 0 ${IMAGE_WIDTH} ${height}" font-family="Inter">`,
    `<clipPath id="card"><rect width="${IMAGE_WIDTH}" height="${height}" rx="24"/></clipPath>`,
    `<rect width="${IMAGE_WIDTH}" height="${height}" rx="24" fill="${THEME.bg}"/>`,
    text(PAD, 66, formatMonth(model.month), { size: 38, fill: THEME.text, weight: 700 }),
    text(IMAGE_WIDTH - PAD, 66, model.subtitle, { size: 20, fill: THEME.muted, anchor: "end" }),
  ];

  WEEKDAYS.forEach((name, i) => {
    parts.push(text(PAD + i * (CELL_W + GAP) + 12, HEADER_H + 22, name, { size: 20, fill: THEME.muted, weight: 700 }));
  });

  days.forEach((date, index) => {
    const slot = offset + index;
    const x = PAD + (slot % 7) * (CELL_W + GAP);
    const y = gridTop + Math.floor(slot / 7) * (CELL_H + GAP);
    const cell = dayCell(date, model.days.get(date), x, y, date === model.today);
    parts.push(date < model.today ? `<g opacity="0.45">${cell}</g>` : cell);
  });

  for (const item of legend) {
    const y = gridBottom + 24 + item.line * LEGEND_LINE_H;
    parts.push(`<g transform="translate(${item.x} ${y})">${item.swatch}${text(36, 19, item.label, { size: 20, fill: THEME.muted })}</g>`);
  }
  parts.push("</svg>");
  return parts.join("");
}
