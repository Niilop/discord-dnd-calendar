import { describe, expect, it } from "vitest";
import { UserError } from "../../src/domain/errors.js";
import {
  addMonths,
  daysInMonth,
  assertTimezone,
  formatSessionTime,
  localDateOf,
  localDatesToUtcRange,
  localDateTimeToUtc,
  parseLocalDate,
  parseLocalTime,
  parseYearMonth,
  todayIn,
} from "../../src/domain/time.js";

describe("parsing", () => {
  it("parses times in common formats", () => {
    expect(parseLocalTime("18:00")).toEqual({ hour: 18, minute: 0 });
    expect(parseLocalTime("18.30")).toEqual({ hour: 18, minute: 30 });
    expect(parseLocalTime("1830")).toEqual({ hour: 18, minute: 30 });
    expect(parseLocalTime("6pm")).toEqual({ hour: 18, minute: 0 });
    expect(parseLocalTime("12am")).toEqual({ hour: 0, minute: 0 });
    expect(() => parseLocalTime("25:00")).toThrow(UserError);
    expect(() => parseLocalTime("13pm")).toThrow(UserError);
  });

  it("accepts region names, whole-hour offsets and IANA names", () => {
    expect(assertTimezone("central european time")).toBe("Europe/Paris");
    expect(assertTimezone("UTC+2")).toBe("UTC+2");
    expect(assertTimezone("+2")).toBe("UTC+2");
    expect(assertTimezone("GMT-5")).toBe("UTC-5");
    expect(assertTimezone("UTC")).toBe("UTC");
    expect(assertTimezone("UTC+0")).toBe("UTC");
    expect(assertTimezone("Europe/Helsinki")).toBe("Europe/Helsinki");
    expect(() => assertTimezone("UTC+15")).toThrow(UserError);
    expect(() => assertTimezone("Mars/Olympus")).toThrow(UserError);
  });

  it("validates dates and months", () => {
    expect(parseLocalDate("2026-10-17")).toBe("2026-10-17");
    expect(() => parseLocalDate("2026-02-30")).toThrow(UserError);
    expect(() => parseLocalDate("17.10.2026")).toThrow(UserError);
    expect(parseYearMonth("2026-3")).toBe("2026-03");
    expect(() => parseYearMonth("2026-13")).toThrow(UserError);
  });
});

describe("timezone conversion", () => {
  it("converts campaign-local wall time to UTC", () => {
    // Helsinki is UTC+3 in October (DST) and UTC+2 in December.
    expect(localDateTimeToUtc("2026-10-17", { hour: 18, minute: 0 }, "Europe/Helsinki").toISOString()).toBe(
      "2026-10-17T15:00:00.000Z",
    );
    expect(localDateTimeToUtc("2026-12-17", { hour: 18, minute: 0 }, "Europe/Helsinki").toISOString()).toBe(
      "2026-12-17T16:00:00.000Z",
    );
    expect(localDateTimeToUtc("2026-10-17", { hour: 18, minute: 0 }, "America/New_York").toISOString()).toBe(
      "2026-10-17T22:00:00.000Z",
    );
  });

  it("rejects wall times skipped by a DST jump", () => {
    // Europe/Helsinki springs forward 03:00 → 04:00 on 2026-03-29.
    expect(() => localDateTimeToUtc("2026-03-29", { hour: 3, minute: 30 }, "Europe/Helsinki")).toThrow(/daylight saving/);
  });

  it("picks the earlier instant for ambiguous wall times", () => {
    // Europe/Helsinki falls back 04:00 → 03:00 on 2026-10-25; 03:30 happens twice.
    const instant = localDateTimeToUtc("2026-10-25", { hour: 3, minute: 30 }, "Europe/Helsinki");
    expect(instant.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("buckets instants into the campaign's local date", () => {
    const instant = new Date("2026-10-16T22:30:00Z");
    expect(localDateOf(instant, "Europe/Helsinki")).toBe("2026-10-17");
    expect(localDateOf(instant, "America/Los_Angeles")).toBe("2026-10-16");
    expect(todayIn("Pacific/Auckland", instant)).toBe("2026-10-17");
  });

  it("computes UTC ranges for local dates across DST", () => {
    const range = localDatesToUtcRange("2026-10-25", "2026-10-25", "Europe/Helsinki");
    expect(range.start.toISOString()).toBe("2026-10-24T21:00:00.000Z");
    // 25 hours long: the clocks go back.
    expect(range.end.toISOString()).toBe("2026-10-25T22:00:00.000Z");
  });

  it("formats in the server timezone with the offset in effect", () => {
    const summer = new Date("2026-10-17T16:00:00Z");
    const winter = new Date("2026-11-14T17:00:00Z");
    expect(formatSessionTime(summer, "Europe/Paris")).toBe("Saturday 17 October — 18:00 (UTC+2)");
    expect(formatSessionTime(winter, "Europe/Paris")).toBe("Saturday 14 November — 18:00 (UTC+1)");
    expect(formatSessionTime(summer, "UTC+2")).toBe("Saturday 17 October — 18:00 (UTC+2)");
    expect(formatSessionTime(summer, "UTC-12")).toBe("Saturday 17 October — 04:00 (UTC-12)");
  });
});

describe("calendar helpers", () => {
  it("enumerates months", () => {
    expect(daysInMonth("2028-02")).toHaveLength(29);
    expect(daysInMonth("2026-10")[0]).toBe("2026-10-01");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });
});
