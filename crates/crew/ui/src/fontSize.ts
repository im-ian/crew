/**
 * How big chat text reads: the bubbles, the code in them, and the message
 * box. The rest of the window keeps its sizes, since its rows and buttons
 * are laid out in fixed pixels; ⌘+ and ⌘− (`appZoom.ts`) grow all of it.
 * The two multiply: zoom scales the pixels this scale is set in.
 */

const KEY = "crew.font-size";

export type FontSize = "small" | "default" | "large" | "larger";

export const FONT_SIZES: readonly FontSize[] = ["small", "default", "large", "larger"];

/** Body text in px for each step. 15px is `--text-xl`, the size chat opens at. */
const PX: Record<FontSize, number> = { small: 13, default: 15, large: 17, larger: 19 };
const BASE_PX = PX.default;

/** Missing or anything unknown is the default, matching a first launch. */
export function fontSizeOf(stored: string | null): FontSize {
  return FONT_SIZES.find((size) => size === stored) ?? "default";
}

/** The factor chat text is multiplied by, read in CSS as `--chat-scale`. */
export function fontScale(size: FontSize): number {
  return PX[size] / BASE_PX;
}

type Root = { style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty"> };

export function applyFontSize(size: FontSize, root: Root = document.documentElement) {
  if (size === "default") root.style.removeProperty("--chat-scale");
  else root.style.setProperty("--chat-scale", String(fontScale(size)));
}

export function loadFontSize(): FontSize {
  try {
    return fontSizeOf(localStorage.getItem(KEY));
  } catch {
    return "default";
  }
}

export function saveFontSize(size: FontSize) {
  try {
    if (size === "default") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, size);
  } catch {
    /* private mode */
  }
}
