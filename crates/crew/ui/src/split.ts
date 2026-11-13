/** Two chats side by side (`row`) or one over the other (`col`), half each. */
export type SplitDir = "row" | "col";
export type Slot = 0 | 1;

/**
 * `panes` holds the bot in each half; an empty half waits for one. `target`
 * is the half the next pick from the sidebar fills. The open chat is in one
 * half, and that half has the composer.
 */
export type Split = {
  dir: SplitDir;
  panes: [string | null, string | null];
  target: Slot;
};

/** Where a bot dropped on the chat area goes. */
export type DropSide = { dir: SplitDir; slot: Slot };

/** Splits the open chat, which keeps the first half. Already split: turns it. */
export function openSplit(cur: Split | null, dir: SplitDir, open: string | null): Split | null {
  if (cur) return cur.dir === dir ? cur : { ...cur, dir };
  if (!open) return null;
  return { dir, panes: [open, null], target: 1 };
}

/**
 * The open chat changed. A bot already in a half takes the keys there,
 * unless the target is an empty half still waiting for its pick; any other
 * bot goes into the target half.
 */
export function placeOpen(cur: Split | null, open: string | null): Split | null {
  if (!cur || !open) return cur;
  const at = cur.panes.indexOf(open);
  if (at >= 0) {
    if (at === cur.target || !cur.panes[cur.target]) return cur;
    return { ...cur, target: at as Slot };
  }
  const panes: Split["panes"] = [...cur.panes];
  panes[cur.target] = open;
  return { ...cur, panes };
}

/** The half the open chat is in. */
export function openSlot(cur: Split | null, open: string | null): Slot | null {
  if (!cur) return open ? 0 : null;
  if (!open) return null;
  const at = cur.panes.indexOf(open);
  return at < 0 ? null : (at as Slot);
}

/** Closing a half leaves the other one as the whole chat. */
export function closeSlot(cur: Split, slot: Slot): { keep: string | null } {
  return { keep: cur.panes[slot === 0 ? 1 : 0] };
}

/** A bot that is gone leaves its half empty. Both gone: no split. */
export function prunePanes(cur: Split | null, live: ReadonlySet<string>): Split | null {
  if (!cur) return cur;
  const panes = cur.panes.map((id) => (id && live.has(id) ? id : null)) as Split["panes"];
  if (!panes[0] && !panes[1]) return null;
  if (panes[0] === cur.panes[0] && panes[1] === cur.panes[1]) return cur;
  return { ...cur, panes };
}

/** The half of the box nearest the point: left or right, top or bottom. */
export function dropSide(
  x: number,
  y: number,
  box: { left: number; top: number; width: number; height: number },
): DropSide {
  const dx = (x - (box.left + box.width / 2)) / Math.max(1, box.width);
  const dy = (y - (box.top + box.height / 2)) / Math.max(1, box.height);
  if (Math.abs(dx) >= Math.abs(dy)) return { dir: "row", slot: dx < 0 ? 0 : 1 };
  return { dir: "col", slot: dy < 0 ? 0 : 1 };
}

/**
 * A bot dropped on one half. The open chat keeps the other half, and a bot
 * dropped where it already is just takes the keys.
 */
export function dropInto(
  cur: Split | null,
  id: string,
  side: DropSide,
  open: string | null,
): Split {
  const other: Slot = side.slot === 0 ? 1 : 0;
  const panes: Split["panes"] = cur ? [...cur.panes] : [null, null];
  if (!cur) {
    panes[other] = open && open !== id ? open : null;
  } else {
    const was = panes.indexOf(id);
    if (was === other) panes[other] = panes[side.slot];
  }
  panes[side.slot] = id;
  return { dir: side.dir, panes, target: side.slot };
}
