/** One chip in the header's waiting line. */
export type WaitChip = {
  id: string;
  /** Arrived after the line was first drawn: it grows in. */
  entering: boolean;
  /** Its bot answered: it glows, folds from `width` and goes. */
  leaving: boolean;
  /** Its width when it started to leave, in px. */
  width?: number;
};

/** How long a leaving chip stays before it is dropped, past its 0.62s fold. */
export const CHIP_LEAVE_MS = 640;

/** The line as first drawn: every chip already there. */
export function initialChips(ids: readonly string[]): WaitChip[] {
  return ids.map((id) => ({ id, entering: false, leaving: false }));
}

/**
 * The chips after the bots waited on changed to `ids`. A chip whose bot is
 * gone starts to leave where it stands; a bot that is new joins the end.
 * One that comes back before it is gone stays. `quick` (reduced motion)
 * drops and adds them at once.
 */
export function nextChips(
  cur: readonly WaitChip[],
  ids: readonly string[],
  quick: boolean,
  widthOf: (id: string) => number | undefined,
): WaitChip[] {
  const next: WaitChip[] = [];
  for (const chip of cur) {
    if (ids.includes(chip.id)) next.push({ ...chip, leaving: false });
    else if (!quick) {
      next.push(chip.leaving ? chip : { ...chip, entering: false, leaving: true, width: widthOf(chip.id) });
    }
  }
  for (const id of ids) {
    if (!cur.some((chip) => chip.id === id)) next.push({ id, entering: !quick, leaving: false });
  }
  return next;
}

/** Leaving chips whose fold is over are dropped. */
export function settleChips(cur: readonly WaitChip[]): WaitChip[] {
  return cur.filter((chip) => !chip.leaving);
}

/** The count beside "waiting": shown from two up, not counting chips on their way out. */
export function chipCount(cur: readonly WaitChip[]): number {
  return cur.filter((chip) => !chip.leaving).length;
}

/** How many chips the sidebar shows before the rest become "+N". */
export const SIDE_CHIPS = 2;

/** The bots on chips that are not on their way out, in order. */
export function liveIds(cur: readonly WaitChip[]): string[] {
  return cur.filter((chip) => !chip.leaving).map((chip) => chip.id);
}

/**
 * The chips' breathing: each glows faintly in its bot's colour once a
 * cycle, left to right like a wave. Four bots or more breathe slower, so a
 * long line stays calm. `delay(i)` is the i-th live chip's offset, seconds.
 */
export function chipRhythm(live: number): { cycle: number; delay: (i: number) => number } {
  const cycle = live > 3 ? 3.2 : 1.8;
  return { cycle, delay: (i) => Math.min(0.6, Math.round(i * 0.12 * cycle * 100) / 100) };
}
