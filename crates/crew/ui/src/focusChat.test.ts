import { describe, expect, it } from "vitest";
import { openPendingOnFocus } from "./focusChat";

describe("window focus", () => {
  it("keeps the chat already on screen", () => {
    expect(openPendingOnFocus("ada", "bob")).toBeNull();
    expect(openPendingOnFocus("ada", "ada")).toBeNull();
    expect(openPendingOnFocus("ada", null)).toBeNull();
  });

  it("opens a pending chat only when nothing is open", () => {
    expect(openPendingOnFocus(null, "bob")).toBe("bob");
    expect(openPendingOnFocus(null, null)).toBeNull();
  });
});
