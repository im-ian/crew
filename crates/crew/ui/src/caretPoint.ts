import { useSyncExternalStore } from "react";

export type CaretPoint = { x: number; y: number };

export function samePoint(a: CaretPoint | null, b: CaretPoint | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

/** Where the caret is, in client pixels. Null when the selection is outside `root`. */
export function caretClientPoint(root: HTMLElement): CaretPoint | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.focusNode;
  if (!node || (node !== root && !root.contains(node))) return null;
  const range = document.createRange();
  try {
    range.setStart(node, sel.focusOffset);
  } catch {
    return null;
  }
  range.collapse(true);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (rect && rect.height > 0) {
    return { x: rect.left, y: rect.top + rect.height / 2 };
  }
  return null;
}

// The caret moves on every key. Held outside React state, so a keystroke
// redraws only the face that follows it, not the app around the composer.
let caret: CaretPoint | null = null;
const listeners = new Set<() => void>();

export function publishCaret(point: CaretPoint | null) {
  if (samePoint(caret, point)) return;
  caret = point;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function stayPut() {
  return () => {};
}

/** The composer caret, or null while `follow` is off. Only a following face listens. */
export function useCaret(follow: boolean): CaretPoint | null {
  return useSyncExternalStore(follow ? subscribe : stayPut, () => (follow ? caret : null));
}
