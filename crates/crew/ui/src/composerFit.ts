/**
 * The composer is a contenteditable box that grows with what is typed up to a
 * limit and scrolls inside past it. Growing it is `height: auto`, then the
 * content's height: and `height: auto` makes the box as tall as its content,
 * which leaves nothing to scroll, so the browser puts `scrollTop` at 0. After
 * that a box that is past its limit shows its first lines, and the line just
 * added (the caret) is below the edge. Every fit therefore keeps the scroll
 * where it was and then brings the caret into view.
 */

/** The limit when the stylesheet gives none. */
export const FIT_MAX = 120;

/** Where the caret is, in the page, or at an end of the text when it has no box of its own. */
export type CaretSpot = { top: number; bottom: number } | "start" | "end";

/** How far to scroll (down is positive) so a caret of `caret` is inside `view`. */
export function caretScrollDelta(
  caret: { top: number; bottom: number },
  view: { top: number; bottom: number },
): number {
  // A view too short to hold the caret keeps its bottom, where the typing is.
  if (caret.bottom - caret.top >= view.bottom - view.top) return caret.bottom - view.bottom;
  if (caret.bottom > view.bottom) return caret.bottom - view.bottom;
  if (caret.top < view.top) return caret.top - view.top;
  return 0;
}

/** The box's height limit: the stylesheet's `max-height`, or `FIT_MAX`. */
export function maxInputHeight(el: Element): number {
  const view = el.ownerDocument?.defaultView;
  const raw = view ? parseFloat(view.getComputedStyle(el).maxHeight) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : FIT_MAX;
}

/**
 * The caret of the selection inside `el`. A caret right after a line break, or
 * at the start of an empty line, has no rectangle in a browser, so then it is
 * said to be at an end of the text when it is, and not found otherwise.
 */
export function caretSpot(el: HTMLElement): CaretSpot | null {
  const doc = el.ownerDocument;
  const sel = doc?.getSelection?.();
  if (!doc || !sel || sel.rangeCount === 0 || !sel.focusNode || !el.contains(sel.focusNode)) {
    return null;
  }
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(false);
  const rects = range.getClientRects();
  const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  if (rect && rect.height > 0) return { top: rect.top, bottom: rect.bottom };
  // What lies after the caret: nothing, or only the line breaks a browser keeps
  // at the end of an editor to give the last empty line a height.
  const after = doc.createRange();
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(el, el.childNodes.length);
  const rest = after.cloneContents();
  const text = (rest.textContent ?? "").replace(/\u200b/g, "");
  if (!text && !rest.querySelector("*:not(br)")) return "end";
  const before = doc.createRange();
  before.setStart(el, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const lead = before.cloneContents();
  if (!(lead.textContent ?? "").replace(/\u200b/g, "") && !lead.querySelector("*")) return "start";
  return null;
}

type Hooks = {
  caretOf?: (el: HTMLElement) => CaretSpot | null;
  maxOf?: (el: HTMLElement) => number;
};

/** Size the box to its content, keep its scroll, and keep the caret in view. */
export function fitInput(el: HTMLElement, hooks: Hooks = {}) {
  const kept = el.scrollTop;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, (hooks.maxOf ?? maxInputHeight)(el))}px`;
  el.scrollTop = kept;
  const spot = (hooks.caretOf ?? caretSpot)(el);
  if (!spot) return;
  if (spot === "end") {
    el.scrollTop = el.scrollHeight;
  } else if (spot === "start") {
    el.scrollTop = 0;
  } else {
    const box = el.getBoundingClientRect();
    el.scrollTop += caretScrollDelta(spot, { top: box.top, bottom: box.bottom });
  }
}
