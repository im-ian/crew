/** How close to the end still counts as reading the newest line. */
export const STICK_PX = 24;

/** What a scroll says about following the newest line. */
export type StickMove = "bottom" | "up" | null;

/**
 * Reaching the end turns following on. Only a move up turns it off.
 * A reflow moves the scroll too, and fires the same event: a narrower
 * window or a picture that loads leaves the thread short of its end before
 * it is put back. Reading that as the reader's own scroll stopped the thread
 * following until they scrolled down by hand.
 */
export function stickMove(lastTop: number | null, top: number, gap: number): StickMove {
  if (gap < STICK_PX) return "bottom";
  if (lastTop !== null && top < lastTop - 1) return "up";
  return null;
}
