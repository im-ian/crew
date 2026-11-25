import type { ChatMessage, MessagesPage } from "./types";

/**
 * Where a chat's loaded rows start in its transcript, and how many rows the
 * transcript had when last asked. The window holds rows `start..total`.
 */
export type PageWindow = { start: number; total: number };

/** A card or an approval that still waits on the user. */
export function waiting(m: ChatMessage): boolean {
  return m.choice?.state === "pending" || m.approval === "pending";
}

/**
 * Where a poll asks from: the last `tail` rows, or the first loaded row that
 * still waits on the user if that is older, so its answer shows. Rows above
 * that are kept as loaded: a chat only adds at its end.
 */
export function pollStart(win: PageWindow, rows: readonly ChatMessage[], tail: number): number {
  const end = Math.max(win.start, win.total - tail);
  const open = rows.findIndex(waiting);
  return open >= 0 ? Math.min(end, win.start + open) : end;
}

/**
 * A poll's page on top of what was loaded. A page that starts at or above
 * the window (the first one, a widened one, or a chat that was cleared) is
 * the whole window.
 */
export function mergeTail(
  win: PageWindow | undefined,
  rows: readonly ChatMessage[],
  page: MessagesPage,
): { rows: ChatMessage[]; win: PageWindow } {
  if (!win || page.start <= win.start || page.start - win.start > rows.length) {
    return { rows: page.messages, win: { start: page.start, total: page.total } };
  }
  return {
    rows: rows.slice(0, page.start - win.start).concat(page.messages),
    win: { start: win.start, total: page.total },
  };
}

/** Older rows that end where the window starts, put in front of it. */
export function mergeAbove(
  win: PageWindow,
  rows: readonly ChatMessage[],
  page: MessagesPage,
): { rows: ChatMessage[]; win: PageWindow } {
  if (page.start >= win.start) return { rows: rows.slice(), win };
  return { rows: page.messages.concat(rows), win: { start: page.start, total: win.total } };
}
