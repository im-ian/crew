import { describe, expect, it } from "vitest";
import { SHORTCUTS, groupedShortcuts, shortcutId } from "./shortcuts";

describe("⌘K", () => {
  it("opens the bot switcher, typing or not", () => {
    expect(shortcutId({ key: "k", metaKey: true }, false)).toBe("quick-switch");
    expect(shortcutId({ key: "k", metaKey: true }, true)).toBe("quick-switch");
    expect(shortcutId({ key: "k", ctrlKey: true }, false)).toBe("quick-switch");
  });

  it("leaves search on ⌘F alone", () => {
    expect(shortcutId({ key: "f", metaKey: true }, false)).toBe("search");
    expect(SHORTCUTS.filter((s) => s.id === "search").map((s) => s.combo)).toEqual(["Meta+F"]);
  });

  it("does not fire while Hangul is composing", () => {
    expect(shortcutId({ key: "k", metaKey: true, isComposing: true }, true)).toBeNull();
  });

  it("is listed once, under Go in the shortcut help", () => {
    const go = groupedShortcuts().find((g) => g.group === "nav")!;
    expect(go.items.filter((s) => s.combo === "Meta+K").map((s) => s.id)).toEqual(["quick-switch"]);
    expect(SHORTCUTS.filter((s) => s.combo === "Meta+K")).toHaveLength(1);
  });
});
