/** Which chat a window-focus event may open.
 *
 * A bot that finishes while the window is away is stored as a pending focus so
 * a notification click can open it. Focusing the window is not that click.
 * The chat already on screen stays. The pending id applies only when nothing
 * is open yet, which is a window that just came up.
 */
export function openPendingOnFocus(
  currentId: string | null,
  pendingId: string | null,
): string | null {
  if (currentId) return null;
  return pendingId;
}
