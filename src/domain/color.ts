import { UserError } from "./errors.js";

/** Named campaign colors. Mid-tone so both white and dark text stay readable on them. */
export const PALETTE = {
  red: "#e5484d",
  orange: "#f76b15",
  amber: "#ffb224",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#3e63dd",
  indigo: "#6e56cf",
  purple: "#8e4ec6",
  pink: "#d6409f",
  brown: "#ad7f58",
  grey: "#8b8d98",
} as const;

export type PaletteName = keyof typeof PALETTE;

export const DEFAULT_CAMPAIGN_COLOR = PALETTE.blue;

/** Accepts a palette name ("teal") or a hex code ("#12a594", "12A594", "#1a9"). Returns lowercase #rrggbb. */
export function parseColor(input: string): string {
  const value = input.trim().toLowerCase();
  if (value in PALETTE) return PALETTE[value as PaletteName];
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (!m) {
    throw new UserError(`"${input}" isn't a color. Use a name (${Object.keys(PALETTE).join(", ")}) or a hex code like #8e4ec6.`);
  }
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return `#${hex}`;
}

export function colorToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

/** Palette name for a stored color, or the hex code itself. */
export function describeColor(hex: string): string {
  return (Object.keys(PALETTE) as PaletteName[]).find((name) => PALETTE[name] === hex) ?? hex;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Black or white, whichever contrasts better with the background. */
export function textColorOn(hex: string): "#111113" | "#ffffff" {
  const l = luminance(hex);
  // Contrast against white vs. near-black (#111113, luminance ≈ 0.006).
  return (l + 0.05) / (0.006 + 0.05) > 1.05 / (l + 0.05) ? "#111113" : "#ffffff";
}

/** Colored-circle emoji closest to a color, for places that only take text (menus, lists). */
const EMOJI_COLORS: [string, string][] = [
  ["🔴", "#dd2e44"],
  ["🟠", "#f4900c"],
  ["🟡", "#fdcb58"],
  ["🟢", "#78b159"],
  ["🔵", "#55acee"],
  ["🟣", "#aa8ed6"],
  ["🟤", "#c1694f"],
  ["⚫", "#31373d"],
  ["⚪", "#e6e7e8"],
];

export function colorEmoji(hex: string): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = rgb(hex) as [number, number, number];
  let best = EMOJI_COLORS[0]!;
  let bestDistance = Infinity;
  for (const entry of EMOJI_COLORS) {
    const [er, eg, eb] = rgb(entry[1]) as [number, number, number];
    const distance = (r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2;
    if (distance < bestDistance) [best, bestDistance] = [entry, distance];
  }
  return best[0];
}
