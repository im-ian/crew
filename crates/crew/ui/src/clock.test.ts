import { describe, expect, it } from "vitest";
import { clockLabel, clockLabels } from "./clock";

const at = (h: number, m: number, day = 9) =>
  new Date(2026, 8, day, h, m).getTime();

const HOUR = 60 * 60 * 1000;

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
  it("stamps the first moment and the next one an hour later", () => {
    const start = at(15, 24);
    const out = clockLabels(
      [start, start + HOUR - 60_000, start + 2 * HOUR],
      "en",
      start,
    );
    expect(out[0]).toMatch(/^3:24/);
    expect(out[1]).toBe("");
    expect(out[2]).toMatch(/^5:24/);
  });

  it("dates a stamp that is not from today", () => {
    const yesterday = at(15, 24, 9);
    const now = at(12, 0, 10);
    expect(clockLabels([yesterday], "en", now)[0]).toMatch(/September/);
    expect(clockLabels([yesterday], "en", now)[0]).toMatch(/3:24/);
    expect(clockLabels([yesterday], "ko", now)[0]).toMatch(/9월/);
    expect(clockLabels([yesterday], "ko", now)[0]).toMatch(/3:24/);
  });

  it("leaves the date off a stamp from today", () => {
    const start = at(15, 24);
    expect(clockLabels([start], "en", start)[0]).toMatch(/^3:24/);
    expect(clockLabels([start], "ko", start)[0]).not.toMatch(/월/);
  });

  it("does not let an unstamped row move the hour", () => {
    const start = at(15, 24);
    const out = clockLabels([start, 0, start + HOUR], "en", start);
    expect(out[1]).toBe("");
    expect(out[2]).toMatch(/^4:24/);
  });

  it("does not stamp a clock that runs backwards", () => {
    const start = at(15, 24);
    const out = clockLabels([start, start + HOUR, start + 30 * 60 * 1000], "en", start);
    expect(out[2]).toBe("");
  });

  it("keeps the same rule in Korean", () => {
    const start = at(15, 24);
    const out = clockLabels([start, start + 60_000, start + HOUR + 60_000], "ko", start);
    expect(out[0]).toContain("3:24");
    expect(out[1]).toBe("");
    expect(out[2]).toContain("4:25");
  });
});
