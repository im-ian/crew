/**
 * Whole-window zoom. ⌘= and ⌘+ grow it, ⌘− shrinks it, ⌘0 is 100%.
 * Steps of 10% from 50% to 200%, remembered across launches.
 *
 * An open picture keeps + − 0, with or without ⌘. This listener is
 * registered first, so it has to leave those keys alone.
 */

const KEY = "crew.zoom";

/** One step, in tenths, so 1.1 + 0.1 does not drift. */
const MIN_TENTHS = 5;
const MAX_TENTHS = 20;

export const ZOOM_MIN = MIN_TENTHS / 10;
export const ZOOM_MAX = MAX_TENTHS / 10;

export type AppZoom = "in" | "out" | "reset";

export type ZoomKeyEvent = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
};

function tenthsOf(scale: number): number {
  if (!Number.isFinite(scale)) return 10;
  return Math.min(MAX_TENTHS, Math.max(MIN_TENTHS, Math.round(scale * 10)));
}

export function clampAppZoom(scale: number): number {
  return tenthsOf(scale) / 10;
}

/** Missing or junk stays at 100%, the size the window opens at. */
export function parseAppZoom(stored: string | null): number {
  if (stored == null || !stored.trim()) return 1;
  const n = Number(stored);
  if (!Number.isFinite(n)) return 1;
  return clampAppZoom(n);
}

export function nextAppZoom(current: number, dir: AppZoom): number {
  if (dir === "reset") return 1;
  const step = dir === "in" ? 1 : -1;
  const t = Math.min(MAX_TENTHS, Math.max(MIN_TENTHS, tenthsOf(current) + step));
  return t / 10;
}

/**
 * ⌘= and ⌘+ (⌘⇧=) zoom in, ⌘− (and ⌘_) out, ⌘0 back to 100%.
 * Ctrl counts too, the same way the other shortcuts treat it as ⌘.
 * Bare + − 0 are the picture preview's keys, not the window's.
 */
export function appZoomKey(e: ZoomKeyEvent): AppZoom | null {
  if (e.isComposing || e.altKey) return null;
  if (!(e.metaKey || e.ctrlKey)) return null;
  if (e.key === "+" || e.key === "=") return "in";
  if (e.key === "-" || e.key === "_") return "out";
  if (e.key === "0") return "reset";
  return null;
}

/** The preview only mounts an <img> for a picture, and that picture owns + − 0. */
export function imagePreviewOwnsZoom(doc: { querySelector(sel: string): unknown }): boolean {
  return doc.querySelector(".img-preview img") != null;
}

/**
 * The next scale when this key changes the window, or null when it does not.
 * Null covers a key that is not zoom, and a zoom key the open picture takes.
 * At 50% or 200% the same scale comes back, so the key is still taken.
 */
export function decideAppZoom(
  e: ZoomKeyEvent,
  current: number,
  previewOwns: boolean,
): number | null {
  const dir = appZoomKey(e);
  if (!dir || previewOwns) return null;
  return nextAppZoom(current, dir);
}

export function loadAppZoom(): number {
  try {
    return parseAppZoom(localStorage.getItem(KEY));
  } catch {
    return 1;
  }
}

export function saveAppZoom(scale: number) {
  try {
    localStorage.setItem(KEY, clampAppZoom(scale).toFixed(1));
  } catch {
    /* private mode */
  }
}

async function applyAppZoom(scale: number): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(clampAppZoom(scale));
  } catch {
    /* vite preview, or the webview refused the scale */
  }
}

export function installAppZoom(doc: Document = document) {
  let current = loadAppZoom();
  if (current !== 1) void applyAppZoom(current);
  const onKey = (e: KeyboardEvent) => {
    const next = decideAppZoom(e, current, imagePreviewOwnsZoom(doc));
    if (next == null) return;
    e.preventDefault();
    if (next === current) return;
    current = next;
    saveAppZoom(current);
    void applyAppZoom(current);
  };
  window.addEventListener("keydown", onKey, true);
}
