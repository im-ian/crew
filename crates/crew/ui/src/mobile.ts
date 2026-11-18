import { useSyncExternalStore } from "react";

/**
 * A phone-wide window: one column, the rail a drawer, side panels and dialogs
 * as full-width sheets. The same width as the `@media` block at the end of
 * styles.css, so script and style switch together.
 */
export const MOBILE_QUERY = "(max-width: 640px)";

function query(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MOBILE_QUERY)
    : null;
}

export function isMobile(): boolean {
  return !!query()?.matches;
}

function subscribe(cb: () => void): () => void {
  const q = query();
  q?.addEventListener("change", cb);
  return () => q?.removeEventListener("change", cb);
}

export function useMobile(): boolean {
  return useSyncExternalStore(subscribe, isMobile, () => false);
}

/**
 * Keeps `--vvh` and `--vv-top` on the root in step with the visual viewport,
 * so the phone layout sizes itself to what the keyboard leaves showing.
 */
export function watchViewport(root: HTMLElement = document.documentElement): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const apply = () => {
    root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    root.style.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    root.style.removeProperty("--vvh");
    root.style.removeProperty("--vv-top");
  };
}

/** From this far in from the left edge, a swipe right opens the rail. */
export const EDGE_PX = 24;
/** How far a finger has to travel before a swipe counts. */
export const SWIPE_PX = 56;

/**
 * Whether a finished swipe moves the drawer: `open` began at the left edge
 * with the rail shut, `close` began on the open rail. A swipe that went more
 * up or down than sideways is a scroll, not a swipe.
 */
export function railSwipe(
  kind: "open" | "close",
  dx: number,
  dy: number,
): boolean {
  if (Math.abs(dy) > Math.abs(dx)) return false;
  return kind === "open" ? dx >= SWIPE_PX : dx <= -SWIPE_PX;
}

export const LONG_PRESS_MS = 480;
/** A finger that moves this far is scrolling, not holding. */
export const LONG_PRESS_SLOP = 10;
/** Where a right click opens a menu: the rail's rows and the routine list. */
export const LONG_PRESS_TARGETS = "aside, .routine";

export function longPressTarget(el: EventTarget | null): Element | null {
  if (!(el instanceof Element)) return null;
  if (el.closest("input, textarea, [contenteditable='true']")) return null;
  return el.closest(LONG_PRESS_TARGETS) ? el : null;
}

/**
 * A held finger opens the same menu a right click does: a `contextmenu` at
 * the finger, on the element under it. Android sends its own on a long
 * press; the first of the two wins and the other is dropped. The tap that
 * ends a hold that opened a menu is not also a click.
 */
export function installLongPress(doc: Document = document): () => void {
  let timer = 0;
  let sx = 0;
  let sy = 0;
  let target: Element | null = null;
  let firedAt = 0;
  let held = false;
  const clear = () => {
    window.clearTimeout(timer);
    timer = 0;
  };
  const open = (el: Element) => {
    held = true;
    firedAt = Date.now();
    const ev = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: sx,
      clientY: sy,
      view: window,
    });
    (ev as MouseEvent & { crewLongPress?: boolean }).crewLongPress = true;
    el.dispatchEvent(ev);
    navigator.vibrate?.(8);
  };
  const onStart = (e: TouchEvent) => {
    clear();
    held = false;
    if (e.touches.length !== 1) return;
    target = longPressTarget(e.target);
    if (!target) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    const el = target;
    timer = window.setTimeout(() => {
      timer = 0;
      open(el);
    }, LONG_PRESS_MS);
  };
  const onMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (timer && t && Math.hypot(t.clientX - sx, t.clientY - sy) > LONG_PRESS_SLOP) clear();
  };
  const onEnd = (e: TouchEvent) => {
    clear();
    if (held) {
      held = false;
      if (e.cancelable) e.preventDefault();
    }
  };
  const onNative = (e: MouseEvent) => {
    if ((e as MouseEvent & { crewLongPress?: boolean }).crewLongPress) return;
    if (Date.now() - firedAt < 1000) {
      // Ours already opened the menu.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (timer) {
      // The platform's came first: let it open the menu, and skip ours.
      clear();
      held = true;
      firedAt = Date.now();
    }
  };
  doc.addEventListener("touchstart", onStart, { passive: true });
  doc.addEventListener("touchmove", onMove, { passive: true });
  doc.addEventListener("touchend", onEnd, { passive: false });
  doc.addEventListener("touchcancel", clear);
  doc.addEventListener("contextmenu", onNative, true);
  return () => {
    clear();
    doc.removeEventListener("touchstart", onStart);
    doc.removeEventListener("touchmove", onMove);
    doc.removeEventListener("touchend", onEnd);
    doc.removeEventListener("touchcancel", clear);
    doc.removeEventListener("contextmenu", onNative, true);
  };
}
