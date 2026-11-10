import { describe, expect, it } from "vitest";
import { fitAxis, liftBy } from "./menuFit";

describe("fitAxis", () => {
  it("opens forward when the menu fits", () => {
    expect(fitAxis(100, 200, 800)).toBe(100);
    expect(fitAxis(592, 200, 800)).toBe(592);
  });

  it("opens backward from the pointer near the far edge", () => {
    // A right click on the last bot in the rail, 40px above the bottom.
    expect(fitAxis(760, 120, 800)).toBe(640);
  });

  it("pushes in from the edge when neither way fits", () => {
    expect(fitAxis(100, 300, 320)).toBe(12);
    expect(fitAxis(100, 400, 320)).toBe(8);
  });
});

describe("liftBy", () => {
  it("lifts only what runs past the edge", () => {
    expect(liftBy(700, 800)).toBe(0);
    expect(liftBy(830, 800)).toBe(38);
  });
});
