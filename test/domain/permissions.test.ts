import { describe, expect, it } from "vitest";
import { PermissionDeniedError } from "../../src/domain/errors.js";
import { assertCan, can, type Action } from "../../src/domain/permissions.js";
import { actor } from "../helpers/fixtures.js";

const user = actor("1");
const guildAdmin = actor("2", { admin: true });

const ADMIN_ONLY: Action[] = [
  "campaign.edit",
  "members.managePlayers",
  "session.create",
  "session.edit",
  "session.cancel",
  "session.viewResponses",
];

describe("permissions", () => {
  it("lets players view, see who is unavailable, set own availability and RSVP", () => {
    for (const action of ["campaign.view", "availability.viewOthers", "availability.editOwn", "rsvp.respond"] as const) {
      expect(can(user, "player", action)).toBe(true);
    }
  });

  it("does not let players manage sessions or members", () => {
    for (const action of ADMIN_ONLY) expect(can(user, "player", action)).toBe(false);
  });

  it("lets campaign admins manage sessions and players, but not other admins or deletion", () => {
    for (const action of ADMIN_ONLY) expect(can(user, "admin", action)).toBe(true);
    expect(can(user, "admin", "members.manageAdmins")).toBe(false);
    expect(can(user, "admin", "campaign.delete")).toBe(false);
  });

  it("lets server admins manage everything even without membership", () => {
    for (const action of [...ADMIN_ONLY, "members.manageAdmins", "campaign.delete", "campaign.view", "availability.viewOthers"] as const) {
      expect(can(guildAdmin, null, action)).toBe(true);
    }
  });

  it("requires membership for personal participation, even for server admins", () => {
    expect(can(guildAdmin, null, "rsvp.respond")).toBe(false);
    expect(can(guildAdmin, null, "availability.editOwn")).toBe(false);
    expect(can(guildAdmin, "player", "rsvp.respond")).toBe(true);
  });

  it("denies non-members everything", () => {
    expect(can(user, null, "campaign.view")).toBe(false);
    expect(() => assertCan(user, null, "session.create")).toThrow(PermissionDeniedError);
  });
});
