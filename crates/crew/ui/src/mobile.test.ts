import { describe, expect, it } from "vitest";
import {
  KEYBOARD_PX,
  REPLY_PX,
  SWIPE_MAX,
  SWIPE_PX,
  isLongPress,
  keyboardOpen,
  railSwipe,
  swipeIntent,
  swipeOffset,
} from "./mobile";

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

describe("keyboardOpen", () => {
  it("sees the keyboard when text is being typed and the screen is well short", () => {
    expect(keyboardOpen(500, 800, true)).toBe(true);
    expect(keyboardOpen(800 - KEYBOARD_PX, 800, true)).toBe(false);
  });

  it("does not take a short screen with nothing typed for a keyboard", () => {
    expect(keyboardOpen(500, 800, false)).toBe(false);
  });
});

describe("swipe to reply", () => {
  it("waits until the finger has moved", () => {
    expect(swipeIntent(-4, 3)).toBe("undecided");
  });

  it("takes a clearly sideways pull to the left as a swipe", () => {
    expect(swipeIntent(-30, 10)).toBe("swipe");
  });

  it("leaves scrolling, a slanted pull and a pull to the right to the page", () => {
    expect(swipeIntent(-12, 30)).toBe("scroll");
    expect(swipeIntent(-20, 15)).toBe("scroll");
    expect(swipeIntent(40, 2)).toBe("scroll");
  });

  it("follows the finger, then drags behind it, and stops at the most", () => {
    expect(swipeOffset(-30)).toBe(-30);
    expect(swipeOffset(-REPLY_PX)).toBe(-REPLY_PX);
    expect(swipeOffset(-REPLY_PX - 20)).toBeCloseTo(-(REPLY_PX + 7));
    expect(swipeOffset(-400)).toBe(-SWIPE_MAX);
    expect(swipeOffset(25)).toBe(-0);
  });
});
