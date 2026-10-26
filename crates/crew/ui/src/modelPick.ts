const CARD_GAP = 8;
const CLIP_INSET = 8;

// Pixels the card may use above the field. A row painted past the scroller
// stays outside that scrollport, so scrolling the list never brings it back.
export function modelCardMaxPx(anchorTop: number, clipTop: number): number {
  return Math.max(0, Math.floor(anchorTop - clipTop - CARD_GAP - CLIP_INSET));
}

export function clipContentTop(node: HTMLElement): number {
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return rect.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
}

export function clippingAncestor(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if (
      overflow === "auto" ||
      overflow === "scroll" ||
      overflow === "hidden" ||
      overflow === "clip"
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}
