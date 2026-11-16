/** What an Enter in the composer does. */
export type EnterAction = "send" | "send-anyway" | "steer" | "line";

/**
 * Enter sends and ⇧Enter breaks the line. ⌘⇧Enter cuts in. ⌘Enter sends like
 * Enter, but over an open question it goes without asking first: the same as
 * "send anyway" in the question dialog. Ctrl stands in for ⌘.
 */
export function enterAction(e: {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): EnterAction | null {
  if (e.key !== "Enter") return null;
  const cmd = !!(e.metaKey || e.ctrlKey);
  if (e.shiftKey) return cmd ? "steer" : "line";
  return cmd ? "send-anyway" : "send";
}
