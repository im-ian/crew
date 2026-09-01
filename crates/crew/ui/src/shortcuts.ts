export type ShortcutGroup = "general" | "nav" | "create" | "chat";

export type Shortcut = {
  id: string;
  combo: string;
  group: ShortcutGroup;
};

/** Shown in the help overlay, in order. Combos use Meta for ⌘/Ctrl. */
export const SHORTCUTS: Shortcut[] = [
  { id: "help", combo: "Meta+/", group: "general" },
  { id: "settings", combo: "Meta+,", group: "general" },
  { id: "search", combo: "Meta+K", group: "nav" },
  { id: "composer", combo: "Meta+J", group: "nav" },
  { id: "prev-chat", combo: "Meta+Alt+ArrowUp", group: "nav" },
  { id: "next-chat", combo: "Meta+Alt+ArrowDown", group: "nav" },
  { id: "bottom", combo: "Meta+Shift+ArrowDown", group: "nav" },
  { id: "new-bot", combo: "Meta+N", group: "create" },
  { id: "new-channel", combo: "Meta+Shift+N", group: "create" },
  { id: "info", combo: "Meta+I", group: "chat" },
  { id: "routines", combo: "Meta+Shift+R", group: "chat" },
  { id: "stop", combo: "Meta+.", group: "chat" },
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
  ...SHORTCUTS.map((s) => [s.combo, s.id]),
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
    [{ key: "k", metaKey: true }, false, "search"],
    [{ key: "n", metaKey: true }, true, "new-bot"],
    [{ key: "N", metaKey: true, shiftKey: true }, false, "new-channel"],
    [{ key: "/", metaKey: true }, false, "help"],
    [{ key: ",", metaKey: true }, false, "settings"],
    [{ key: ".", metaKey: true }, true, "stop"],
    [{ key: "?", metaKey: true, shiftKey: true }, false, "help"],
    [{ key: "?", shiftKey: true }, false, "help"],
    [{ key: "?", shiftKey: true }, true, null],
    [{ key: "Enter", metaKey: true }, false, "approve"],
    [{ key: "ArrowDown", metaKey: true, altKey: true }, false, "next-chat"],
    [{ key: "ArrowDown", metaKey: true, shiftKey: true }, false, "bottom"],
  ];
  for (const [e, typing, id] of cases) {
    const got = shortcutId(e, typing);
    if (got !== id) {
      throw new Error(`shortcut ${comboOf(e)} typing=${typing}: got ${got} want ${id}`);
    }
  }
}

selfCheck();
