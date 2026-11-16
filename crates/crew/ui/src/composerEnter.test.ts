import { describe, expect, it } from "vitest";
import { enterAction } from "./composerEnter";

describe("enterAction", () => {
  it("sends on Enter, and ⌘Enter or Ctrl+Enter sends over a question", () => {
    expect(enterAction({ key: "Enter" })).toBe("send");
    expect(enterAction({ key: "Enter", metaKey: true })).toBe("send-anyway");
    expect(enterAction({ key: "Enter", ctrlKey: true })).toBe("send-anyway");
  });

  it("keeps ⌘⇧Enter as steer and ⇧Enter as a new line", () => {
    expect(enterAction({ key: "Enter", metaKey: true, shiftKey: true })).toBe("steer");
    expect(enterAction({ key: "Enter", ctrlKey: true, shiftKey: true })).toBe("steer");
    expect(enterAction({ key: "Enter", shiftKey: true })).toBe("line");
  });

  it("leaves other keys alone", () => {
    expect(enterAction({ key: "a", metaKey: true })).toBe(null);
  });
});
