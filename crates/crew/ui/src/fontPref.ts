const KEY = "crew.font-family";

/** Names CSS reads as keywords. Quoted, each would be looked up as a font. */
const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "math",
  "emoji",
  "fangsong",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "-apple-system",
  "blinkmacsystemfont",
]);

function isGeneric(name: string): boolean {
  return GENERIC.has(name.toLowerCase());
}

/** The font names typed, comma between them, with any quotes taken off. */
export function fontNames(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim().replace(/^(["'])(.*)\1$/, "$2").trim())
    .filter(Boolean);
}

/**
 * The typed names as a `font-family` list, each font quoted so a name with
 * a space or a digit reads as one font. The app's own stack follows, so a
 * letter the chosen font lacks still has a face. Empty when nothing is typed.
 */
export function fontStack(input: string): string {
  const names = fontNames(input);
  if (!names.length) return "";
  const quoted = names.map((name) =>
    isGeneric(name) ? name : `"${name.replace(/["\\]/g, "\\$&")}"`,
  );
  return [...quoted, "var(--sans)"].join(", ");
}

/**
 * The typed fonts this Mac does not have. A missing font falls back, so a
 * line set in it measures the same as in the fallback, under both a serif
 * and a monospace fallback.
 */
export function missingFonts(input: string, measure: (family: string) => number): string[] {
  return fontNames(input).filter((name) => {
    if (isGeneric(name)) return false;
    const font = `"${name.replace(/["\\]/g, "\\$&")}"`;
    return ["serif", "monospace"].every(
      (base) => measure(`${font}, ${base}`) === measure(base),
    );
  });
}

/** How wide a sample line is in `family`, on a canvas. */
export function canvasMeasure(): (family: string) => number {
  const ctx = document.createElement("canvas").getContext("2d");
  return (family) => {
    if (!ctx) return 0;
    ctx.font = `48px ${family}`;
    return ctx.measureText("mmmmmmmmmmlli WWww 가나다라마 0123").width;
  };
}

export function applyFont(input: string) {
  const stack = fontStack(input);
  const root = document.documentElement.style;
  if (stack) root.setProperty("--font-user", stack);
  else root.removeProperty("--font-user");
}

export function loadFont(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveFont(input: string) {
  try {
    if (input.trim()) localStorage.setItem(KEY, input);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}
