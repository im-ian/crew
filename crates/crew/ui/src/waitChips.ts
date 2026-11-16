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

/** How many faces the sidebar shows before the rest become "+N". */
export const WAIT_FACES = 2;

/** The sidebar's faces, two at most, and the bots left for "+N". */
export function splitFaces(ids: readonly string[]): { faces: string[]; rest: string[] } {
  return { faces: ids.slice(0, WAIT_FACES), rest: ids.slice(WAIT_FACES) };
}
