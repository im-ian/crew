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
