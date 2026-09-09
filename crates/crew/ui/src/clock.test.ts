import { describe, expect, it } from "vitest";
import { clockLabel, clockLabels } from "./clock";

const at = (h: number, m: number, s = 0) => new Date(2026, 8, 9, h, m, s).getTime();

describe("clockLabel", () => {
  it("reads as a wall clock", () => {
    expect(clockLabel(at(15, 24), "en-US")).toBe("3:24 PM");
    // Node ships with less ICU data in some builds, so pin the part every
    // build agrees on rather than the localised am/pm marker.
    expect(clockLabel(at(15, 24), "ko")).toContain("3:24");
  });

  it("has nothing to say without a stamp", () => {
    expect(clockLabel(0, "en-US")).toBe("");
  });
});

describe("clockLabels", () => {
  it("stamps only the first message of a minute", () => {
    const rows = [at(15, 24), at(15, 24, 40), at(15, 25)];
    expect(clockLabels(rows, "en-US")).toEqual(["3:24 PM", "", "3:25 PM"]);
  });

  it("does not let an unstamped row swallow the next minute", () => {
    // A tool run or a folded note sits between two messages.
    const rows = [at(15, 24), 0, at(15, 25), 0, at(15, 25)];
    expect(clockLabels(rows, "en-US")).toEqual(["3:24 PM", "", "3:25 PM", "", ""]);
  });

  it("stamps again when the minute comes back around", () => {
    const rows = [at(15, 24), at(15, 25), at(15, 24)];
    expect(clockLabels(rows, "en-US")).toEqual(["3:24 PM", "3:25 PM", "3:24 PM"]);
  });
});
