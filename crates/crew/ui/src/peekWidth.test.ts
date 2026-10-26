import { describe, expect, it } from "vitest";
import { clampPeek, PEEK_MIN, peekMax } from "./peekWidth";

describe("clampPeek", () => {
  it("keeps the default floor", () => {
    expect(clampPeek(100, 1200)).toBe(PEEK_MIN);
    expect(clampPeek(Number.NaN, 1200)).toBe(PEEK_MIN);
    expect(peekMax(0)).toBe(PEEK_MIN);
    expect(peekMax(Number.NaN)).toBe(PEEK_MIN);
  });

  it("widens up to 70% once the thread still has room", () => {
    // 1600 * 0.7 = 1120, and the thread still has 480, which is above 280.
    expect(peekMax(1600)).toBe(1120);
    expect(clampPeek(2000, 1600)).toBe(1120);
    expect(clampPeek(640.4, 1600)).toBe(640);
  });

  it("stops at the thread's minimum on a narrower column", () => {
    // 900 - 280 = 620, and 70% is 630, so the thread wins.
    expect(peekMax(900)).toBe(620);
    expect(clampPeek(800, 900)).toBe(620);
  });

  it("does not shrink the floor when the column is already tight", () => {
    expect(peekMax(500)).toBe(PEEK_MIN);
    expect(clampPeek(100, 500)).toBe(PEEK_MIN);
  });
});
