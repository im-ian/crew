import { describe, expect, it } from "vitest";
import { SWIPE_PX, isLongPress, railSwipe } from "./mobile";

describe("railSwipe", () => {
  it("opens on a swipe right from the edge", () => {
    expect(railSwipe("open", SWIPE_PX, 4)).toBe(true);
    expect(railSwipe("open", SWIPE_PX - 1, 0)).toBe(false);
    expect(railSwipe("open", -SWIPE_PX, 0)).toBe(false);
  });

  it("closes on a swipe left on the rail", () => {
    expect(railSwipe("close", -SWIPE_PX - 10, 8)).toBe(true);
    expect(railSwipe("close", SWIPE_PX, 0)).toBe(false);
  });

  it("leaves a scroll alone", () => {
    expect(railSwipe("open", 80, 120)).toBe(false);
    expect(railSwipe("close", -80, -90)).toBe(false);
  });
});

describe("isLongPress", () => {
  it("tells a held finger from a right click", () => {
    const click = new Event("contextmenu");
    const held = Object.assign(new Event("contextmenu"), { crewLongPress: true });
    expect(isLongPress(click)).toBe(false);
    expect(isLongPress(held)).toBe(true);
  });
});
