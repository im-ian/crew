/** How many pictures a row shows before the rest become "+N". */
export const GALLERY_CAP = 5;

/** Pictures hidden after the row's last cell, or 0 when they all fit. */
export function galleryExtra(count: number): number {
  if (!Number.isFinite(count) || count <= GALLERY_CAP) return 0;
  return count - GALLERY_CAP;
}

/** Where an arrow key moves in an open album.
 *  Null means the key is not album navigation. At either end the index
 *  stays put, so the key is still taken and the chat does not scroll. */
export function imageStep(key: string, index: number, count: number): number | null {
  if (count < 2) return null;
  let delta = 0;
  if (key === "ArrowLeft" || key === "ArrowUp") delta = -1;
  else if (key === "ArrowRight" || key === "ArrowDown") delta = 1;
  else return null;
  const next = index + delta;
  if (next < 0 || next >= count) return index;
  return next;
}
