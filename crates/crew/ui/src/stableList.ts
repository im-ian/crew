/** Same JSON-like value, field by field. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], bb[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  for (const k of keys) {
    if (!(k in bo) || !sameValue(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * A poll hands back a fresh list each time. Keep the old one when nothing in
 * it changed, and the old rows that did not, so React skips the redraw and a
 * memo keyed on a row keeps what it made.
 */
export function keepSame<T>(prev: readonly T[], next: readonly T[]): T[] {
  let changed = prev.length !== next.length;
  const out = next.map((row, i) => {
    const old = prev[i];
    if (i < prev.length && sameValue(old, row)) return old;
    changed = true;
    return row;
  });
  return changed ? out : (prev as T[]);
}
