import { describe, expect, it } from "vitest";
import { STICK_PX, stickMove } from "./stick";

describe("stickMove", () => {
  it("follows again once the reader is at the end", () => {
    expect(stickMove(500, 900, 0)).toBe("bottom");
    expect(stickMove(null, 0, STICK_PX - 1)).toBe("bottom");
  });

  it("stops following when the reader moves up", () => {
    expect(stickMove(900, 600, 300)).toBe("up");
  });

  it("keeps following when a reflow leaves the thread short of its end", () => {
    // A narrower window wraps the lines: the scroll moves down, the end
    // moves further, and the event fires before the thread is put back.
    expect(stickMove(1977, 2456, 184)).toBeNull();
    // A picture loads under the last line: nothing moves but the end.
    expect(stickMove(1977, 1977, 210)).toBeNull();
  });

  it("does not read the first check as a move", () => {
    expect(stickMove(null, 0, 400)).toBeNull();
  });

  it("ignores a sub-pixel wobble", () => {
    expect(stickMove(900, 899.5, 300)).toBeNull();
  });
});
