/** Kept between a menu and the window's edge. */
export const MENU_MARGIN = 8;

/**
 * Where a menu opened at `at` along one axis starts, so all `size` of it is
 * in a window `room` long. It opens forward when it fits, backward from the
 * pointer when it does not, as a macOS menu does, and is pushed in from the
 * edge when neither way fits.
 */
export function fitAxis(at: number, size: number, room: number, margin = MENU_MARGIN): number {
  if (at + size <= room - margin) return at;
  if (at - size >= margin) return at - size;
  return Math.max(margin, room - margin - size);
}

/** How far a submenu that ends at `bottom` moves up to stay in the window. */
export function liftBy(bottom: number, room: number, margin = MENU_MARGIN): number {
  return Math.max(0, bottom - (room - margin));
}
