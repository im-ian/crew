import { describe, expect, it } from "vitest";
import { clockLabel, clockLabels } from "./clock";

const at = (h: number, m: number, day = 9) =>
  new Date(2026, 8, day, h, m).getTime();

describe("clockLabel", () => {
  it("reads as a wall clock", () => {
    // The separator before the day period is U+202F on some ICU builds and a
    // plain space on others, so match the shape rather than the byte.
    expect(clockLabel(at(15, 24), "en")).toMatch(/^3:24\s?PM$/);
    expect(clockLabel(at(15, 24), "ko")).toContain("3:24");
  });

  it("has nothing to say without a stamp", () => {
    expect(clockLabel(0, "en")).toBe("");
  });
});

describe("clockLabels", () => {
  it("stamps only the first message of a minute", () => {
    const rows = [at(15, 24), at(15, 24), at(15, 25)];
    const out = clockLabels(rows, "en");
    expect(out[0]).toMatch(/3:24/);
    expect(out[1]).toBe("");
    expect(out[2]).toMatch(/3:25/);
  });

  it("stamps the same minute again on a later day", () => {
    const out = clockLabels([at(15, 24, 9), at(15, 24, 10)], "en");
    expect(out[0]).toMatch(/3:24/);
    expect(out[1]).toMatch(/3:24/);
  });

  it("does not let an unstamped row swallow the next minute", () => {
    // A tool run or a folded note sits between two messages.
    const out = clockLabels([at(15, 24), 0, at(15, 25), 0, at(15, 25)], "en");
    expect(out[1]).toBe("");
    expect(out[2]).toMatch(/3:25/);
    expect(out[4]).toBe("");
  });

  it("stamps again when the minute comes back around", () => {
    const out = clockLabels([at(15, 24), at(15, 25), at(15, 24)], "en");
    expect(out.every((s) => s !== "")).toBe(true);
  });

  it("dedupes in the locale the app defaults to", () => {
    const out = clockLabels([at(15, 24), at(15, 24), at(15, 25)], "ko");
    expect(out[0]).toContain("3:24");
    expect(out[1]).toBe("");
    expect(out[2]).toContain("3:25");
  });
});
