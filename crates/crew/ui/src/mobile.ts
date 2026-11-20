import { useSyncExternalStore } from "react";

/**
 * A phone layout: one column, the rail a drawer, side panels and dialogs as
 * full-width sheets. A narrow window, or a short touch screen such as a
 * phone on its side, whatever its width. The same query as the phone
 * `@media` block in styles.css, so script and style switch together.
 */
export const MOBILE_QUERY = "(max-width: 640px), (hover: none) and (max-height: 500px)";

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

/** A screen worked by finger: no hover, so no mouse to drag with and no keyboard shortcuts at hand. */
export const TOUCH_QUERY = "(hover: none)";

function touchQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(TOUCH_QUERY)
    : null;
}

export function isTouch(): boolean {
  return !!touchQuery()?.matches;
}

export function useTouch(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const q = touchQuery();
      q?.addEventListener("change", cb);
      return () => q?.removeEventListener("change", cb);
    },
    isTouch,
    () => false,
  );
}

/** How much of the screen a keyboard takes before it counts as up. */
export const KEYBOARD_PX = 120;

/**
 * Whether the on-screen keyboard is up: something takes text, and the
 * visible height is well short of the tallest seen at this width (the
 * screen without a keyboard).
 */
export function keyboardOpen(height: number, tallest: number, typing: boolean): boolean {
  return typing && tallest - height > KEYBOARD_PX;
}

function takesText(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !["button", "checkbox", "radio", "range", "submit", "file", "color"].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * How long after a keyboard goes iOS may still be moving the view back. It
 * can put the visual viewport's offset back to 0 with no `scroll` event, so
 * the values are read again over that time rather than only on events.
 */
export const SETTLE_MS = [0, 120, 360, 720];

/**
 * Keeps `--vvh` and `--vv-top` on the root in step with the visual viewport,
 * so the phone layout sizes itself to what the keyboard leaves showing, and
 * marks the root `kb-open` while the keyboard is up: the home indicator is
 * under the keyboard then, so nothing has to keep clear of it.
 *
 * When the keyboard goes, the page is put back at the top: iOS can leave the
 * layout scrolled or the old offset in place, and the app then stayed pushed
 * down. A page pinched in pans on its own, so it is not followed.
 */
export function watchViewport(root: HTMLElement = document.documentElement): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  let width = 0;
  let tallest = 0;
  let wasOpen = false;
  let timers: number[] = [];
  const read = () => {
    const zoomed = Math.abs((vv.scale || 1) - 1) > 0.01;
    const top = zoomed ? 0 : Math.max(0, Math.round(vv.offsetTop));
    root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    root.style.setProperty("--vv-top", `${top}px`);
    // Turning or unfolding the phone makes a new screen, with a new tallest.
    if (Math.round(vv.width) !== width) {
      width = Math.round(vv.width);
      tallest = 0;
    }
    tallest = Math.max(tallest, vv.height);
    const open = keyboardOpen(vv.height, tallest, takesText(document.activeElement));
    root.classList.toggle("kb-open", open);
    return open;
  };
  // The keyboard went, or a field let go: read again while iOS settles.
  const settle = () => {
    for (const t of timers) window.clearTimeout(t);
    timers = SETTLE_MS.map((ms) =>
      window.setTimeout(() => {
        if (takesText(document.activeElement)) return;
        if (window.scrollY !== 0) window.scrollTo(0, 0);
        wasOpen = read();
      }, ms),
    );
  };
  const apply = () => {
    const open = read();
    if (wasOpen && !open) settle();
    wasOpen = open;
  };
  const onFocusIn = () => apply();
  const onFocusOut = () => {
    apply();
    settle();
  };
  // Back from the background or from the page cache: iOS may have put the
  // view right while the page slept, with no event for it.
  const onShown = () => {
    if (document.visibilityState === "hidden") return;
    apply();
    settle();
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  window.addEventListener("scroll", apply);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("visibilitychange", onShown);
  window.addEventListener("pageshow", onShown);
  return () => {
    for (const t of timers) window.clearTimeout(t);
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    window.removeEventListener("scroll", apply);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("visibilitychange", onShown);
    window.removeEventListener("pageshow", onShown);
    root.style.removeProperty("--vvh");
    root.style.removeProperty("--vv-top");
    root.classList.remove("kb-open");
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
/**
 * Where a held finger opens a menu: the rail's rows and the routine list. A
 * message is left to the system: holding it selects its text.
 */
export const LONG_PRESS_TARGETS = "aside, .routine";

/** A `contextmenu` this file sent for a held finger, not a right click. */
export function isLongPress(e: Event): boolean {
  return !!(e as Event & { crewLongPress?: boolean }).crewLongPress;
}

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

/** How far a balloon is pulled left before letting go starts a reply. */
export const REPLY_PX = 60;
/** The furthest a balloon goes, however far the finger does. */
export const SWIPE_MAX = 96;

/**
 * What a finger that moved `dx, dy` from where it landed is doing. A swipe
 * is clearly sideways and to the left; up, down or right is the page's
 * (scrolling, or the rail's edge swipe). Undecided until it has moved.
 */
export function swipeIntent(dx: number, dy: number): "undecided" | "swipe" | "scroll" {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 10 && ay < 10) return "undecided";
  return dx < 0 && ax > ay * 1.5 ? "swipe" : "scroll";
}

/** Where the balloon sits: with the finger up to REPLY_PX, then dragging behind it. */
export function swipeOffset(dx: number): number {
  const d = Math.max(0, -dx);
  const o = d <= REPLY_PX ? d : REPLY_PX + (d - REPLY_PX) * 0.35;
  return -Math.min(o, SWIPE_MAX);
}

const REPLY_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';

/** A balloon row that can be answered: it carries its own reply button. */
function replyRow(el: EventTarget | null): { row: HTMLElement; bubble: HTMLElement; reply: HTMLElement } | null {
  if (!(el instanceof Element)) return null;
  const row = el.closest<HTMLElement>(".bubble-row");
  if (!row) return null;
  const reply = row.querySelector<HTMLElement>(":scope > .msg-actions .reply-btn");
  const bubble = row.querySelector<HTMLElement>(":scope > .bubble, :scope > .dots-clip");
  return reply && bubble ? { row, bubble, reply } : null;
}

/** A table or code block that scrolls sideways keeps the finger for itself. */
function scrollsSideways(el: Element): boolean {
  const box = el.closest<HTMLElement>(".md-table, pre");
  return !!box && box.scrollWidth > box.clientWidth + 1;
}

/**
 * Swipe a balloon right to left to answer it, as in a messenger: it follows
 * the finger, a reply arrow shows behind it and grows once the pull is far
 * enough, and letting go there starts the reply (the row's own reply
 * button). Less, and it springs back. One listener for the whole page.
 */
export function installSwipeReply(doc: Document = document): () => void {
  let drag: {
    row: HTMLElement;
    bubble: HTMLElement;
    reply: HTMLElement;
    x: number;
    y: number;
    mode: "undecided" | "swipe" | "scroll";
    armed: boolean;
    icon: HTMLElement | null;
  } | null = null;
  const settle = (fire: boolean) => {
    const d = drag;
    drag = null;
    if (!d || d.mode !== "swipe") return;
    d.bubble.style.transition = "transform 0.32s cubic-bezier(0.2, 1.4, 0.4, 1)";
    d.bubble.style.transform = "";
    const icon = d.icon;
    if (icon) {
      icon.style.opacity = "0";
      window.setTimeout(() => icon.remove(), 260);
    }
    window.setTimeout(() => {
      d.bubble.style.transition = "";
    }, 340);
    if (fire && d.armed) d.reply.click();
  };
  const onStart = (e: TouchEvent) => {
    drag = null;
    if (e.touches.length !== 1) return;
    const hit = replyRow(e.target);
    if (!hit || !(e.target instanceof Element) || scrollsSideways(e.target)) return;
    // Text being selected keeps the finger for the selection.
    if (doc.getSelection()?.toString()) return;
    const t = e.touches[0];
    drag = { ...hit, x: t.clientX, y: t.clientY, mode: "undecided", armed: false, icon: null };
  };
  const onMove = (e: TouchEvent) => {
    const d = drag;
    const t = e.touches[0];
    if (!d || !t || d.mode === "scroll") return;
    const dx = t.clientX - d.x;
    const dy = t.clientY - d.y;
    if (d.mode === "undecided") {
      d.mode = swipeIntent(dx, dy);
      if (d.mode !== "swipe") return;
      d.bubble.style.transition = "none";
      const icon = doc.createElement("span");
      icon.className = "swipe-reply";
      icon.innerHTML = REPLY_SVG;
      d.row.appendChild(icon);
      d.icon = icon;
    }
    if (e.cancelable) e.preventDefault();
    const off = swipeOffset(dx);
    d.bubble.style.transform = `translateX(${off}px)`;
    if (d.icon) d.icon.style.opacity = String(Math.min(1, -off / REPLY_PX));
    const armed = -dx >= REPLY_PX;
    if (armed !== d.armed) {
      d.armed = armed;
      d.icon?.classList.toggle("is-armed", armed);
      if (armed) navigator.vibrate?.(8);
    }
  };
  const onEnd = () => settle(true);
  const onCancel = () => settle(false);
  doc.addEventListener("touchstart", onStart, { passive: true });
  doc.addEventListener("touchmove", onMove, { passive: false });
  doc.addEventListener("touchend", onEnd);
  doc.addEventListener("touchcancel", onCancel);
  return () => {
    settle(false);
    doc.removeEventListener("touchstart", onStart);
    doc.removeEventListener("touchmove", onMove);
    doc.removeEventListener("touchend", onEnd);
    doc.removeEventListener("touchcancel", onCancel);
  };
}

/**
 * A tap on a balloon shows its time, copy and reply under it, the buttons a
 * mouse finds on hover, for a finger that cannot swipe. Another tap, or a
 * tap anywhere else, hides them. A tap on a link or a button inside it, or
 * one that ends a text selection, is left alone.
 */
export function installTapActions(doc: Document = document): () => void {
  const onClick = (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    const shown = doc.querySelector(".bubble-row.show-actions");
    if (target?.closest(".msg-actions")) return;
    const row = target?.closest<HTMLElement>(".bubble-row");
    const actions = row?.querySelector(":scope > .msg-actions");
    if (!row || !actions || target?.closest("a, button, input, textarea, summary, [contenteditable='true']") || doc.getSelection()?.toString()) {
      shown?.classList.remove("show-actions");
      return;
    }
    if (shown && shown !== row) shown.classList.remove("show-actions");
    row.classList.toggle("show-actions");
  };
  doc.addEventListener("click", onClick);
  return () => {
    doc.removeEventListener("click", onClick);
    doc.querySelector(".bubble-row.show-actions")?.classList.remove("show-actions");
  };
}
