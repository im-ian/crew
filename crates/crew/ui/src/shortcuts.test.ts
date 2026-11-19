import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  focusComposerOnTab,
  groupedShortcuts,
  shortcutId,
  tabPlace,
  tabPlaceOf,
  type TabGate,
} from "./shortcuts";

const openChat: TabGate = { web: false, composer: true, blocked: false };

function node(hit: (selector: string) => boolean) {
  return { closest: (selector: string) => (hit(selector) ? {} : null) };
}

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

describe("Tab focuses the composer", () => {
  it("moves from nowhere into the composer", () => {
    let focused = false;
    let prevented = false;
    const taken = focusComposerOnTab(
      {
        key: "Tab",
        preventDefault() {
          prevented = true;
        },
      },
      "none",
      openChat,
      () => {
        focused = true;
      },
    );
    expect(taken).toBe(true);
    expect(focused).toBe(true);
    expect(prevented).toBe(true);
  });

  it("moves from chat text into the composer", () => {
    expect(tabPlaceOf(node((sel) => sel.includes(".bubble")))).toBe("chat");
    expect(focusComposerOnTab({ key: "Tab" }, "chat", openChat, () => {})).toBe(true);
  });

  it("leaves Tab alone inside another field or a modal", () => {
    expect(tabPlaceOf(node((sel) => sel.includes("textarea")))).toBe("field");
    expect(tabPlaceOf(node((sel) => sel.includes(".modal")))).toBe("modal");
    expect(tabPlaceOf(node((sel) => sel.includes(".choice-card")))).toBe("question");
    expect(focusComposerOnTab({ key: "Tab" }, "field", openChat, () => {})).toBe(false);
    expect(focusComposerOnTab({ key: "Tab" }, "modal", openChat, () => {})).toBe(false);
    expect(focusComposerOnTab({ key: "Tab" }, "question", openChat, () => {})).toBe(false);
  });

  it("leaves Tab alone on the sidebar and the header", () => {
    expect(tabPlaceOf(node((sel) => sel.includes("aside")))).toBe("sidebar");
    expect(tabPlaceOf(node((sel) => sel.includes("header")))).toBe("header");
    expect(focusComposerOnTab({ key: "Tab" }, "sidebar", openChat, () => {})).toBe(false);
    expect(focusComposerOnTab({ key: "Tab" }, "header", openChat, () => {})).toBe(false);
  });

  it("ignores IME composition and Shift+Tab", () => {
    expect(focusComposerOnTab({ key: "Tab", isComposing: true }, "none", openChat, () => {})).toBe(
      false,
    );
    expect(focusComposerOnTab({ key: "Tab", shiftKey: true }, "none", openChat, () => {})).toBe(
      false,
    );
  });

  it("does nothing on the phone page, or when the chat has no composer", () => {
    expect(focusComposerOnTab({ key: "Tab" }, "none", { ...openChat, web: true }, () => {})).toBe(
      false,
    );
    expect(
      focusComposerOnTab({ key: "Tab" }, "none", { ...openChat, composer: false }, () => {}),
    ).toBe(false);
    expect(
      focusComposerOnTab({ key: "Tab" }, "none", { ...openChat, blocked: true }, () => {}),
    ).toBe(false);
  });

  it("is listed in help and is not a captured shortcut", () => {
    expect(shortcutId({ key: "Tab" }, false)).toBeNull();
    const go = groupedShortcuts().find((g) => g.group === "nav")!;
    expect(go.items.filter((s) => s.id === "composerTab").map((s) => s.combo)).toEqual(["Tab"]);
  });
});

describe("tabPlace", () => {
  it("asks the element itself, as a browser's closest() needs", () => {
    // A browser's closest() throws when called on anything but the element:
    // it ran on every key press and stopped the shortcuts after it.
    class Node {
      constructor(private readonly inside: string) {}
      closest(sel: string) {
        if (!(this instanceof Node)) throw new TypeError("Can only call Element.closest on instances of Element");
        return sel.includes(this.inside) ? this : null;
      }
    }
    expect(tabPlace(new Node(".bubble") as unknown as EventTarget)).toBe("chat");
    expect(tabPlace(new Node("textarea") as unknown as EventTarget)).toBe("field");
  });
});
