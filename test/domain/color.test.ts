import { describe, expect, it } from "vitest";
import { describeColor, parseColor, PALETTE, textColorOn } from "../../src/domain/color.js";
import { UserError } from "../../src/domain/errors.js";

describe("colors", () => {
  it("accepts palette names and hex codes", () => {
    expect(parseColor("Teal")).toBe(PALETTE.teal);
    expect(parseColor("#8E4EC6")).toBe("#8e4ec6");
    expect(parseColor("8e4ec6")).toBe("#8e4ec6");
    expect(parseColor("#1a9")).toBe("#11aa99");
    expect(() => parseColor("blurple-ish")).toThrow(UserError);
    expect(() => parseColor("#12345")).toThrow(UserError);
  });

  it("describes palette colors by name", () => {
    expect(describeColor(PALETTE.red)).toBe("red");
    expect(describeColor("#123456")).toBe("#123456");
  });

  it("picks readable text colors", () => {
    expect(textColorOn(PALETTE.amber)).toBe("#111113");
    expect(textColorOn("#1e1f22")).toBe("#ffffff");
    expect(textColorOn(PALETTE.indigo)).toBe("#ffffff");
  });
});
