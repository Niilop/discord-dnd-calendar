import { describe, expect, it } from "vitest";
import { describeDayAvailability, describeDayConflicts, summarizeAvailability } from "../../src/domain/availability.js";
import type { AvailabilityEntry } from "../../src/domain/types.js";

const entry = (userId: string, date: string, status: AvailabilityEntry["status"]): AvailabilityEntry => ({
  guildId: "1",
  userId,
  date,
  status,
});

describe("summarizeAvailability", () => {
  const members = ["a", "b", "c", "d", "e"];
  const dates = ["2026-10-16", "2026-10-17", "2026-10-18"];

  it("counts only marks; unmarked people are unknown, not available", () => {
    const summary = summarizeAvailability(dates, members, [
      entry("a", "2026-10-16", "unavailable"),
      entry("b", "2026-10-16", "prefer_not"),
      entry("c", "2026-10-18", "unavailable"),
    ]);
    expect(describeDayAvailability(summary.get("2026-10-16")!)).toBe("1 can't · 1 unsure");
    expect(describeDayAvailability(summary.get("2026-10-17")!)).toBe("nobody marked");
    expect(describeDayAvailability(summary.get("2026-10-18")!)).toBe("1 can't");
    expect(summary.get("2026-10-16")!.unavailable).toEqual(["a"]);
    expect(describeDayConflicts(summary.get("2026-10-17")!)).toBeNull();
    expect(describeDayConflicts(summary.get("2026-10-16")!)).toBe("1 unavailable, 1 unsure");
  });

  it("ignores entries from non-members and dates outside the range", () => {
    const summary = summarizeAvailability(dates, members, [
      entry("zz", "2026-10-16", "unavailable"),
      entry("a", "2026-11-01", "unavailable"),
    ]);
    expect(summary.get("2026-10-16")!.available).toBe(5);
    expect(summary.size).toBe(3);
  });
});
