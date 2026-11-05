/** Wait before a single click, so a double-click can rename instead. */
export const NAME_CLICK_MS = 400;

/** Trimmed name to store, or null when the edit should be dropped. */
export function commitName(draft: string, current: string): string | null {
  const name = draft.trim();
  if (!name || name === current.trim()) return null;
  return name;
}
