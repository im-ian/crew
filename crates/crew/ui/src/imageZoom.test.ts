import { describe, expect, it } from "vitest";
import { clampView, FIT, MAX_SCALE, wheelFactor, zoomAt, zoomKey } from "./imageZoom";

const picture = { width: 400, height: 300 };
const room = { width: 1000, height: 800 };

describe("zoomAt", () => {
  it("keeps the point under the pointer still", () => {
    // 200px right of centre is 200px right of the picture's centre at 1x.
    const big = { width: 800, height: 600 };
    const view = zoomAt(FIT, 2, { x: 200, y: 0 }, big, room);
    expect(view.scale).toBe(2);
    // That spot is now 400px out from the picture's centre; it moves back by 200.
    expect(view.x).toBe(-200);
  });

  it("stops at the largest zoom and comes back to the fit", () => {
    expect(zoomAt(FIT, 100, { x: 0, y: 0 }, picture, room).scale).toBe(MAX_SCALE);
    expect(zoomAt({ scale: 2, x: 50, y: 20 }, 0.1, { x: 0, y: 0 }, picture, room)).toEqual(FIT);
  });
});

describe("clampView", () => {
  it("lets a zoomed picture move only until its edge meets the window", () => {
    // 4x is 1600 × 1200 in a 1000 × 800 window: 300 and 200 of slack each way.
    expect(clampView({ scale: 4, x: 999, y: -999 }, picture, room)).toEqual({ scale: 4, x: 300, y: -200 });
  });

  it("keeps a side that still fits centred", () => {
    expect(clampView({ scale: 2, x: 80, y: 40 }, picture, room)).toEqual({ scale: 2, x: 0, y: 0 });
  });
});

describe("wheelFactor", () => {
  it("zooms in on a pinch out and out on a pinch in", () => {
    expect(wheelFactor(-10)).toBeGreaterThan(1);
    expect(wheelFactor(10)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
  });
});

describe("zoomKey", () => {
  it("reads + − 0 with or without ⌘", () => {
    expect(zoomKey({ key: "=", metaKey: true })).toBe("in");
    expect(zoomKey({ key: "+" })).toBe("in");
    expect(zoomKey({ key: "-", metaKey: true })).toBe("out");
    expect(zoomKey({ key: "0" })).toBe("fit");
    expect(zoomKey({ key: "ArrowLeft" })).toBeNull();
    expect(zoomKey({ key: "=", altKey: true })).toBeNull();
  });
});
