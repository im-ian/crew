export type Shortcut = {
  id: string;
  combo: string;
  group: string;
  label: string;
};

/** Shown in the help overlay, in order. Combos use Meta for ⌘/Ctrl. */
export const SHORTCUTS: Shortcut[] = [
  { id: "help", combo: "Meta+/", group: "일반", label: "단축키 보기" },
  { id: "search", combo: "Meta+K", group: "이동", label: "검색" },
  { id: "composer", combo: "Meta+J", group: "이동", label: "입력창" },
  { id: "prev-chat", combo: "Meta+Alt+ArrowUp", group: "이동", label: "이전 대화" },
  { id: "next-chat", combo: "Meta+Alt+ArrowDown", group: "이동", label: "다음 대화" },
  { id: "bottom", combo: "Meta+Shift+ArrowDown", group: "이동", label: "맨 아래로" },
  { id: "new-bot", combo: "Meta+N", group: "만들기", label: "새 봇" },
  { id: "new-channel", combo: "Meta+Shift+N", group: "만들기", label: "새 채널" },
  { id: "info", combo: "Meta+I", group: "대화", label: "정보" },
  { id: "routines", combo: "Meta+Shift+R", group: "대화", label: "루틴" },
  { id: "stop", combo: "Meta+.", group: "대화", label: "중지" },
  { id: "attach", combo: "Meta+U", group: "대화", label: "파일 첨부" },
  { id: "approve", combo: "Meta+Enter", group: "대화", label: "한 번 허용" },
  { id: "deny", combo: "Meta+Backspace", group: "대화", label: "거부" },
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

export function formatCombo(combo: string): string[] {
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
        return "스페이스";
      default:
        return part;
    }
  });
}

export function groupedShortcuts(): { group: string; items: Shortcut[] }[] {
  const groups: { group: string; items: Shortcut[] }[] = [];
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
