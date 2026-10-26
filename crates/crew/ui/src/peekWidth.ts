/** Floor matches the side chat's default clamp. */
export const PEEK_MIN = 320;

/** The thread keeps at least this much when the side chat is dragged wider. */
const THREAD_MIN = 280;

/** Largest share of the chat column the side chat may take. */
const PEEK_SHARE = 0.7;

export function peekMax(mainW: number): number {
  if (!Number.isFinite(mainW) || mainW <= 0) return PEEK_MIN;
  const cap = Math.min(
    Math.floor(mainW - THREAD_MIN),
    Math.floor(mainW * PEEK_SHARE),
  );
  return Math.max(PEEK_MIN, cap);
}

export function clampPeek(px: number, mainW: number): number {
  const n = Number.isFinite(px) ? Math.round(px) : PEEK_MIN;
  return Math.min(peekMax(mainW), Math.max(PEEK_MIN, n));
}
