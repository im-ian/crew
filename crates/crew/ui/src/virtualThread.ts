/**
 * Which slice of a long thread to mount.
 *
 * Short threads stay in normal flow (the queued-row pin, the flex gap, the
 * entrance). Past the threshold only a window of rows is mounted, at measured
 * heights, so a long history does not parse markdown for every balloon.
 * The gap matches `--space-14` on `.thread`. Rows are positioned by the
 * caller, so this file never reads the DOM.
 */

/** Past this many rows the thread mounts a window instead of the whole list. */
export const VIRTUAL_THRESHOLD = 80;

/** Height used until a row is measured. A short balloon is near this. */
export const ROW_ESTIMATE = 96;

/** Pixels mounted past the viewport so a fast scroll does not flash blank. */
export const OVERSCAN_PX = 800;

/** Fallback when the thread has not reported `--space-14` yet. */
export const ROW_GAP = 14;

/** A viewport we have not measured yet still mounts about one screen. */
const UNMEASURED_VIEW = 640;

export type FlowWindow = {
  /** Inclusive index in the flow list. */
  start: number;
  /** Exclusive index. */
  end: number;
  /** False when the whole list is mounted. */
  virtual: boolean;
};

/**
 * `offsets[i]` is the y of row i. `offsets[count]` is the height of every
 * row plus the gap after each row except the last.
 */
export function rowOffsets(
  count: number,
  heightOf: (index: number) => number,
  gap = ROW_GAP,
): number[] {
  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  for (let i = 0; i < count; i++) {
    const gapAfter = i + 1 < count ? gap : 0;
    offsets[i + 1] = offsets[i] + heightOf(i) + gapAfter;
  }
  return offsets;
}

/**
 * The rows that intersect the viewport, plus overscan.
 * `stick` keeps the window on the tail so a reply that is still arriving
 * stays mounted even before the scroller catches the new height.
 */
export function flowWindow(opts: {
  count: number;
  scrollTop: number;
  viewport: number;
  offsets: readonly number[];
  stick?: boolean;
  overscan?: number;
  threshold?: number;
}): FlowWindow {
  const threshold = opts.threshold ?? VIRTUAL_THRESHOLD;
  if (opts.count <= threshold) {
    return { start: 0, end: opts.count, virtual: false };
  }
  const overscan = opts.overscan ?? OVERSCAN_PX;
  const total = opts.offsets[opts.count] ?? 0;
  const view = opts.viewport > 0 ? opts.viewport : UNMEASURED_VIEW;
  const top = opts.stick
    ? Math.max(0, total - view - overscan)
    : Math.max(0, opts.scrollTop - overscan);
  const bottom = opts.stick ? total : opts.scrollTop + view + overscan;
  return {
    start: findStart(opts.offsets, top),
    end: findEnd(opts.offsets, bottom, opts.count),
    virtual: true,
  };
}

/** First row that still meets the viewport top. */
export function anchorIndex(
  offsets: readonly number[],
  scrollTop: number,
  count: number,
): number {
  if (count <= 0) return 0;
  return Math.min(findStart(offsets, Math.max(0, scrollTop)), count - 1);
}

/**
 * How far to move scrollTop so `anchor` stays put after heights above it
 * change. A change at or below the anchor does not move its offset.
 */
export function anchorShift(
  before: readonly number[],
  after: readonly number[],
  anchor: number,
): number {
  return (after[anchor] ?? 0) - (before[anchor] ?? 0);
}

/**
 * scrollTop that puts `index` near the middle of the viewport.
 * A search hit uses this so the window mounts the rows around it, not only
 * the hit itself, before the scroller moves.
 */
export function scrollForIndex(
  offsets: readonly number[],
  index: number,
  viewport: number,
  total: number,
): number {
  const view = viewport > 0 ? viewport : UNMEASURED_VIEW;
  const rowTop = offsets[index] ?? 0;
  const next = offsets[index + 1] ?? rowTop;
  const rowH = Math.max(0, next - rowTop);
  const target = rowTop - (view - rowH) / 2;
  const max = Math.max(0, total - view);
  return Math.min(max, Math.max(0, target));
}

/** Indexes the window must also mount, such as a search hit that is off screen. */
export function extraIndexes(
  count: number,
  start: number,
  end: number,
  wanted: readonly number[],
): number[] {
  const out: number[] = [];
  for (const i of wanted) {
    if (i >= 0 && i < count && (i < start || i >= end)) out.push(i);
  }
  return out;
}

/** Window indexes plus extras, in order, without duplicates. */
export function mountedIndexes(
  start: number,
  end: number,
  extra: readonly number[],
): number[] {
  const set = new Set<number>();
  for (let i = start; i < end; i++) set.add(i);
  for (const i of extra) set.add(i);
  return [...set].sort((a, b) => a - b);
}

/** Ignore an empty measure and sub-pixel noise so a row does not reflow itself. */
export function acceptHeight(prev: number | undefined, next: number): boolean {
  if (next < 1) return false;
  if (prev === undefined) return true;
  return Math.abs(prev - next) >= 1;
}

function findStart(offsets: readonly number[], top: number): number {
  let lo = 0;
  let hi = Math.max(0, offsets.length - 1);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= top) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function findEnd(offsets: readonly number[], bottom: number, count: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid] ?? 0) < bottom) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
