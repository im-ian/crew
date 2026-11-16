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

/**
 * Where a thread goes after the box around it was rebuilt. Splitting the chat
 * turns the halves from display: contents into grids, and WebKit drops the
 * thread's scroll to the top then. Read as a move up, that drop stopped the
 * thread following and left it at its first line. A thread that followed the
 * end goes back to it; any other goes back to where the last check found it.
 */
export function rebuiltTop(follow: boolean, lastTop: number | null, end: number): number | null {
  if (follow) return end;
  return lastTop;
}
