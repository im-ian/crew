import { describe, expect, it } from "vitest";
import {
  acceptHeight,
  anchorIndex,
  anchorShift,
  extraIndexes,
  flowWindow,
  mountedIndexes,
  rowOffsets,
  scrollForIndex,
  VIRTUAL_THRESHOLD,
} from "./virtualThread";

describe("rowOffsets", () => {
  it("puts the gap after every row except the last", () => {
    expect(rowOffsets(3, () => 10, 2)).toEqual([0, 12, 24, 34]);
  });
});

describe("flowWindow", () => {
  const offsets = rowOffsets(5, () => 10, 0);

  it("mounts a short thread whole", () => {
    expect(
      flowWindow({
        count: 10,
        scrollTop: 500,
        viewport: 100,
        offsets: rowOffsets(10, () => 50, 0),
      }),
    ).toEqual({ start: 0, end: 10, virtual: false });
  });

  it("starts at the first row that meets the viewport", () => {
    const win = flowWindow({
      count: 5,
      scrollTop: 20,
      viewport: 15,
      offsets,
      overscan: 0,
      threshold: 0,
    });
    expect(win).toEqual({ start: 2, end: 4, virtual: true });
  });

  it("keeps the tail mounted while the reader is stuck to the bottom", () => {
    const long = rowOffsets(200, () => 50, 10);
    const win = flowWindow({
      count: 200,
      scrollTop: 0,
      viewport: 400,
      offsets: long,
      stick: true,
      threshold: VIRTUAL_THRESHOLD,
    });
    expect(win.virtual).toBe(true);
    expect(win.end).toBe(200);
    expect(win.start).toBeGreaterThan(0);
    expect(long[win.start]).toBeLessThanOrEqual(long[200] - 400);
  });

  it("pulls rows in above the viewport by the overscan", () => {
    const dense = rowOffsets(40, () => 10, 0);
    const win = flowWindow({
      count: 40,
      scrollTop: 100,
      viewport: 10,
      offsets: dense,
      overscan: 30,
      threshold: 0,
    });
    expect(win.start).toBe(7);
    expect(win.end).toBe(14);
  });
});

describe("anchorShift", () => {
  it("moves with a height change above the anchor and ignores one below it", () => {
    const before = rowOffsets(4, () => 100, 0);
    const grownAbove = rowOffsets(4, (i) => (i === 0 ? 120 : 100), 0);
    const grownBelow = rowOffsets(4, (i) => (i === 2 ? 140 : 100), 0);
    expect(anchorIndex(before, 200, 4)).toBe(2);
    expect(anchorShift(before, grownAbove, 2)).toBe(20);
    expect(anchorShift(before, grownBelow, 2)).toBe(0);
  });
});

describe("scrollForIndex", () => {
  it("centers the row and stays inside the scroll range", () => {
    const offsets = [0, 100, 200, 300];
    expect(scrollForIndex(offsets, 0, 100, 300)).toBe(0);
    expect(scrollForIndex(offsets, 2, 100, 300)).toBe(200);
  });
});

describe("mounted indexes", () => {
  it("adds a hit that sits outside the window", () => {
    expect(extraIndexes(100, 10, 20, [5, 15, 30, -1, 100])).toEqual([5, 30]);
    expect(mountedIndexes(2, 4, [0, 3])).toEqual([0, 2, 3]);
  });
});

describe("acceptHeight", () => {
  it("drops an empty measure and sub-pixel noise", () => {
    expect(acceptHeight(undefined, 0)).toBe(false);
    expect(acceptHeight(undefined, 12)).toBe(true);
    expect(acceptHeight(12, 12.4)).toBe(false);
    expect(acceptHeight(12, 14)).toBe(true);
  });
});
