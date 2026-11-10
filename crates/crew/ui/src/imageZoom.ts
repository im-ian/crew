/** A picture's zoom in the preview: 1 is fitted to the window. */
export type ZoomView = { scale: number; x: number; y: number };

export const FIT: ZoomView = { scale: 1, x: 0, y: 0 };
export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
/** One press of + or −, or one click of the buttons. */
export const ZOOM_STEP = 1.5;
/** A double click on a fitted picture goes this far in. */
export const DOUBLE_CLICK_SCALE = 2.5;

export type Size = { width: number; height: number };

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Keep a zoomed picture over the window: it can move until its edge reaches
 * the window's, and no further. A side that fits stays centred.
 */
export function clampView(view: ZoomView, picture: Size, room: Size): ZoomView {
  const scale = clampScale(view.scale);
  if (scale === MIN_SCALE) return FIT;
  const maxX = Math.max(0, (picture.width * scale - room.width) / 2);
  const maxY = Math.max(0, (picture.height * scale - room.height) / 2);
  return {
    scale,
    x: Math.min(maxX, Math.max(-maxX, view.x)),
    y: Math.min(maxY, Math.max(-maxY, view.y)),
  };
}

/**
 * Zoom by `factor` about `at`, a point measured from the window's centre,
 * so the spot under the pointer stays under it.
 */
export function zoomAt(
  view: ZoomView,
  factor: number,
  at: { x: number; y: number },
  picture: Size,
  room: Size,
): ZoomView {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return clampView(
    { scale, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k },
    picture,
    room,
  );
}

/** A trackpad pinch or a ⌘-scroll arrives as wheel steps; this is one step's zoom. */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.01);
}

/** What a key does to an open picture, or null when it is not a zoom key. */
export function zoomKey(e: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): "in" | "out" | "fit" | null {
  if (e.altKey) return null;
  if (e.key === "+" || e.key === "=") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "fit";
  return null;
}
