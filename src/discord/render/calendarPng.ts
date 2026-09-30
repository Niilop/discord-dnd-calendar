import { Resvg } from "@resvg/resvg-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCalendarSvg, type CalendarImageModel } from "./calendarImage.js";

/** Bundled fonts (repo-root assets/fonts), so output is identical locally and in Docker. */
const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../assets/fonts");
const FONT_FILES = [path.join(FONT_DIR, "Inter_400Regular.ttf"), path.join(FONT_DIR, "Inter_700Bold.ttf")];

export const CALENDAR_IMAGE_NAME = "calendar.png";

export function renderCalendarPng(model: CalendarImageModel): Buffer {
  const resvg = new Resvg(renderCalendarSvg(model), {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Inter" },
  });
  return resvg.render().asPng();
}
