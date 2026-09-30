import { describe, expect, it } from "vitest";
import { encodeCustomId, parseCustomId, type CustomId } from "../../src/discord/customIds.js";

const bulk = { campaignId: 12, month: "2026-11", mask: 2 ** 30 + 5 };

const samples: CustomId[] = [
  { kind: "cv", mode: "view", month: "2026-10", campaignId: 0, mask: 0, sessionId: 0 },
  { kind: "cv", mode: "edit", month: "2026-10", campaignId: 0, mask: 0, sessionId: 99 },
  { kind: "cv", mode: "add", month: "2026-11", campaignId: 12, mask: 2 ** 30 + 5, sessionId: 0 },
  { kind: "cv.pick", mode: "avail", month: "2026-11", campaignId: 0, mask: 6, sessionId: 0, from: 16, to: 30 },
  { kind: "cv.mark", month: "2026-10", mask: 6, status: "prefer_not" },
  { kind: "cv.mark", month: "2026-10", mask: 6, status: "unspecified" },
  { kind: "cv.camp", month: "2026-10", mask: 3 },
  { kind: "cv.edit" },
  { kind: "bk.go", ...bulk },
  { kind: "bk.create", ...bulk, mask: 0 },
  { kind: "se.view", sessionId: 99 },
  { kind: "se.camp", sessionId: 99 },
  { kind: "se.time", sessionId: 99 },
  { kind: "se.timeset", sessionId: 99 },
  { kind: "se.cancel", sessionId: 99 },
  { kind: "se.confirm", sessionId: 99 },
  { kind: "rsvp", sessionId: 99, status: "absent" },
  { kind: "ss.remind", sessionId: 99 },
];

describe("custom ids", () => {
  it("round-trips every kind within Discord's 100-char limit", () => {
    for (const id of samples) {
      const encoded = encodeCustomId(id);
      expect(encoded.length).toBeLessThanOrEqual(100);
      expect(parseCustomId(encoded)).toEqual(id);
    }
  });

  it("rejects malformed, tampered and old-version ids", () => {
    for (const raw of [
      "",
      "v3:cal.nav:2026-10", // previous version
      "v3:rsvp:1:a",
      "v4:rsvp:abc:a",
      "v4:rsvp:1:z",
      "v4:cv:q:2026-10:0:0:0", // unknown mode
      "v4:cv:v:2026-10:0:0", // no session field
      "v4:cv:v:2026-13x:0:0:0",
      "v4:cv.pick:a:2026-10:0:0:0:16:32",
      "v4:cv.pick:a:2026-10:0:0:0:20:10",
      "v4:cv.mark:2026-10:0:q",
      "v4:bk.go:12:2026-11:zzzzzzzz",
      "v4:unknown:1",
    ]) {
      expect(parseCustomId(raw)).toBeNull();
    }
  });
});
