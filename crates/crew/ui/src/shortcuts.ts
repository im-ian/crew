export type ShortcutGroup = "general" | "nav" | "create" | "chat";

export type Shortcut = {
  id: string;
  combo: string;
  group: ShortcutGroup;
  /** Listed in help only. Not a key the app captures on its own. */
  showOnly?: boolean;
};

/** Shown in the help overlay, in order. Combos use Meta for ⌘/Ctrl. */
export const SHORTCUTS: Shortcut[] = [
  { id: "help", combo: "Meta+/", group: "general" },
  { id: "settings", combo: "Meta+,", group: "general" },
  { id: "quick-switch", combo: "Meta+K", group: "nav" },
  { id: "search", combo: "Meta+F", group: "nav" },
  { id: "composer", combo: "Meta+J", group: "nav" },
  // Tab focuses the composer only when it is not already focused. shortcutId leaves it alone.
  { id: "composerTab", combo: "Tab", group: "nav", showOnly: true },
  { id: "prev-chat", combo: "Meta+Alt+ArrowUp", group: "nav" },
  { id: "next-chat", combo: "Meta+Alt+ArrowDown", group: "nav" },
  { id: "bottom", combo: "Meta+Shift+ArrowDown", group: "nav" },
  { id: "split-row", combo: "Meta+D", group: "nav" },
  { id: "split-col", combo: "Meta+Shift+D", group: "nav" },
  { id: "new-bot", combo: "Meta+N", group: "create" },
  { id: "quick-bot", combo: "Meta+Shift+N", group: "create" },
  { id: "info", combo: "Meta+I", group: "chat" },
  { id: "routines", combo: "Meta+Shift+R", group: "chat" },
  { id: "stop", combo: "Meta+.", group: "chat" },
  { id: "steer", combo: "Meta+Shift+Enter", group: "chat" },
  { id: "attach", combo: "Meta+U", group: "chat" },
  { id: "approve", combo: "Meta+Enter", group: "chat" },
  { id: "deny", combo: "Meta+Backspace", group: "chat" },
];

const ALIAS: Record<string, string> = {
  "Meta+/": "help",
  "Meta+?": "help",
  "Meta+Shift+?": "help",
  "Meta+Shift+/": "help",
};

const BY_COMBO: Record<string, string> = Object.fromEntries([
  ...SHORTCUTS.filter((s) => !s.showOnly).map((s) => [s.combo, s.id]),
  ...Object.entries(ALIAS),
]);

export type KeyEventLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
};

export function comboOf(e: KeyEventLike): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  const key = normalizeKey(e.key);
  if (e.shiftKey && key !== "Shift" && !singleShifted(e.key)) parts.push("Shift");
  if (key === "Meta" || key === "Control" || key === "Alt" || key === "Shift") {
    return parts.join("+") || key;
  }
  parts.push(key);
  return parts.join("+");
}

function singleShifted(key: string): boolean {
  return key.length === 1 && key !== key.toLowerCase() && key !== key.toUpperCase();
}

function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const el = target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']");
  return !!el;
}

export function shortcutId(e: KeyEventLike, typing: boolean): string | null {
  if (e.isComposing) return null;
  const combo = comboOf(e);
  if (!typing && (combo === "?" || combo === "Shift+?")) return "help";
  const id = BY_COMBO[combo];
  if (!id) return null;
  return id;
}

export type TabPlace =
  | "none"
  | "chat"
  | "field"
  | "sidebar"
  | "header"
  | "modal"
  | "menu"
  | "question"
  | "other";

export type TabGate = {
  /** The phone page. Tab keeps the browser's order there. */
  web: boolean;
  /** A bot chat is open and it has a composer. A terminal does not. */
  composer: boolean;
  /** A dialog, sheet, or menu is up, even when the keys are not inside it. */
  blocked: boolean;
};

const TAB_FIELD = "input, textarea, select, [contenteditable='true'], [role='textbox']";
const TAB_QUESTION = ".choice-card, .ask-hold";
const TAB_MODAL = ".modal, .overlay, [role='dialog'], [aria-modal='true']";
const TAB_MENU = ".ctx, [role='menu'], .mention-menu, .plus-menu, [data-popover-open]";
const TAB_CHROME = ".composer, .split-standin, .peek-room, .file-view, .lead-pane";
const TAB_CONTROL = "button, a, [role='button'], [role='link'], summary";
const TAB_CHAT = ".thread, .thread-row, .bubble, .bubble-row, .empty-chat, .split-pane";

/** Where a plain Tab is. `none` is the page itself (document.body). */
export function tabPlaceOf(node: { closest(selector: string): unknown }): TabPlace {
  const hit = (sel: string) => node.closest(sel) != null;
  if (hit(TAB_FIELD)) return "field";
  if (hit(TAB_QUESTION)) return "question";
  if (hit(TAB_MODAL)) return "modal";
  if (hit(TAB_MENU)) return "menu";
  if (hit("aside")) return "sidebar";
  if (hit("header")) return "header";
  if (hit(TAB_CHROME) || hit(TAB_CONTROL)) return "other";
  if (hit(TAB_CHAT)) return "chat";
  return "other";
}

export function tabPlace(target: EventTarget | null): TabPlace {
  if (target == null) return "none";
  if (
    typeof document !== "undefined" &&
    (target === document.body || target === document.documentElement)
  ) {
    return "none";
  }
  const node = target as unknown as { closest?: (selector: string) => unknown };
  if (typeof node.closest !== "function") return "other";
  // Called on the node itself: a browser's closest() taken off its element
  // throws, and this runs on every key press.
  return tabPlaceOf(node as { closest(selector: string): unknown });
}

/**
 * Plain Tab moves into the open chat's composer when nothing is focused, or
 * when focus is on the chat's text. Shift+Tab, IME, the phone page, another
 * field, a dialog, the sidebar, and header buttons keep the browser's order.
 */
export function tabFocusesComposer(e: KeyEventLike, place: TabPlace, gate: TabGate): boolean {
  if (gate.web || !gate.composer || gate.blocked) return false;
  if (e.isComposing || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false;
  if (e.key !== "Tab") return false;
  return place === "none" || place === "chat";
}

/** The same focus ⌘J uses. Returns whether Tab was taken. */
export function focusComposerOnTab(
  e: KeyEventLike & { preventDefault?: () => void },
  place: TabPlace,
  gate: TabGate,
  focus: () => void,
): boolean {
  if (!tabFocusesComposer(e, place, gate)) return false;
  e.preventDefault?.();
  focus();
  return true;
}

export function formatCombo(combo: string, spaceLabel = "Space"): string[] {
  return combo.split("+").map((part) => {
    switch (part) {
      case "Meta":
        return "⌘";
      case "Alt":
        return "⌥";
      case "Shift":
        return "⇧";
      case "ArrowUp":
        return "↑";
      case "ArrowDown":
        return "↓";
      case "ArrowLeft":
        return "←";
      case "ArrowRight":
        return "→";
      case "Enter":
        return "↩";
      case "Backspace":
        return "⌫";
      case "Escape":
        return "Esc";
      case "Space":
        return spaceLabel;
      default:
        return part;
    }
  });
}

export function groupedShortcuts(): { group: ShortcutGroup; items: Shortcut[] }[] {
  const groups: { group: ShortcutGroup; items: Shortcut[] }[] = [];
  for (const s of SHORTCUTS) {
    const last = groups[groups.length - 1];
    if (last && last.group === s.group) last.items.push(s);
    else groups.push({ group: s.group, items: [s] });
  }
  return groups;
}

function selfCheck() {
  const cases: Array<[KeyEventLike, boolean, string | null]> = [
    [{ key: "f", metaKey: true }, false, "search"],
    [{ key: "f", metaKey: true }, true, "search"],
    [{ key: "k", metaKey: true }, false, "quick-switch"],
    [{ key: "k", metaKey: true }, true, "quick-switch"],
    [{ key: "n", metaKey: true }, true, "new-bot"],
    [{ key: "N", metaKey: true, shiftKey: true }, false, "quick-bot"],
    [{ key: "N", metaKey: true, shiftKey: true }, true, "quick-bot"],
    [{ key: "/", metaKey: true }, false, "help"],
    [{ key: ",", metaKey: true }, false, "settings"],
    [{ key: ".", metaKey: true }, true, "stop"],
    [{ key: "?", metaKey: true, shiftKey: true }, false, "help"],
    [{ key: "?", shiftKey: true }, false, "help"],
    [{ key: "?", shiftKey: true }, true, null],
    [{ key: "Enter", metaKey: true }, false, "approve"],
    [{ key: "Enter", metaKey: true, shiftKey: true }, true, "steer"],
    [{ key: "ArrowDown", metaKey: true, altKey: true }, false, "next-chat"],
    [{ key: "ArrowDown", metaKey: true, shiftKey: true }, false, "bottom"],
    [{ key: "d", metaKey: true }, true, "split-row"],
    [{ key: "D", metaKey: true, shiftKey: true }, false, "split-col"],
  ];
  for (const [e, typing, id] of cases) {
    const got = shortcutId(e, typing);
    if (got !== id) {
      throw new Error(`shortcut ${comboOf(e)} typing=${typing}: got ${got} want ${id}`);
    }
  }
}

selfCheck();
