import { describe, expect, it } from "vitest";
import { STICK_PX, rebuiltTop, stickMove } from "./stick";

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

describe("rebuiltTop", () => {
  // ⌘D turns the chat's halves from display: contents into grids, and WebKit
  // drops the thread's scroll to 0. Left there, the next check reads a move up.
  it("reads the drop to the top as a move up, so it must be put back", () => {
    expect(stickMove(1407, 0, 2766)).toBe("up");
  });

  it("puts a thread that followed the end back at its new end", () => {
    expect(rebuiltTop(true, 1407, 4090)).toBe(4090);
    const top = rebuiltTop(true, 1407, 4090) ?? 0;
    expect(stickMove(1407, top, 0)).toBe("bottom");
  });

  it("puts a reader who had moved up back where they were", () => {
    expect(rebuiltTop(false, 507, 4090)).toBe(507);
    expect(stickMove(507, rebuiltTop(false, 507, 4090) ?? 0, 2259)).toBeNull();
  });

  it("leaves a thread no check has seen alone", () => {
    expect(rebuiltTop(false, null, 4090)).toBeNull();
  });
});
