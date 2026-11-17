const BODY_KEY = "crew.font-family";
const CODE_KEY = "crew.font-family.code";
const CODE_FALLBACK = "var(--mono-builtin)";

/** One family for every installed Nerd Font. CSS limits it to private-use icons. */
export const NERD_FAMILY = "Crew Nerd Icons";
const NERD_STYLE = "crew-nerd-fonts";
/** BMP private use, then the two supplementary private-use planes. */
const NERD_RANGE = "U+E000-F8FF, U+F0000-FFFFD, U+100000-10FFFD";

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

/** A font name inside a CSS string. */
export function quoteFont(name: string): string {
  return `"${name.replace(/["\\]/g, "\\$&")}"`;
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
 * a space or a digit reads as one font. `fallback` follows, so a letter the
 * chosen font lacks still has a face. Empty when nothing is typed.
 */
export function fontStack(input: string, fallback = "var(--sans)"): string {
  const names = fontNames(input);
  if (!names.length) return "";
  const quoted = names.map((name) => (isGeneric(name) ? name : quoteFont(name)));
  return [...quoted, fallback].join(", ");
}

/**
 * The typed fonts this Mac does not have. A missing font falls back, so a
 * line set in it measures the same as in the fallback, under both a serif
 * and a monospace fallback.
 */
export function missingFonts(input: string, measure: (family: string) => number): string[] {
  return fontNames(input).filter((name) => {
    if (isGeneric(name)) return false;
    const font = quoteFont(name);
    return ["serif", "monospace"].every(
      (base) => measure(`${font}, ${base}`) === measure(base),
    );
  });
}

/**
 * How wide a sample line is in `family`, laid out in the page. Not on a
 * canvas: WebKit's canvas sees only the fonts macOS ships, so a font the
 * user installed reads as missing there while the page draws it fine.
 */
export function pageMeasure(): (family: string) => number {
  return (family) => {
    const span = document.createElement("span");
    span.textContent = "mmmmmmmmmmlli WWww 가나다라마 0123";
    span.style.cssText =
      "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-size:48px";
    span.style.fontFamily = family;
    document.body.append(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width;
  };
}

export function applyFont(input: string) {
  const stack = fontStack(input);
  const root = document.documentElement.style;
  if (stack) root.setProperty("--font-user", stack);
  else root.removeProperty("--font-user");
}

export function loadFont(): string {
  return loadStored(BODY_KEY);
}

export function saveFont(input: string) {
  saveStored(BODY_KEY, input);
}

/** The typed code fonts as `--mono-user`. Empty clears it, so `--mono` stays the built-in stack. */
export function applyCodeFont(input: string) {
  const stack = fontStack(input, CODE_FALLBACK);
  const root = document.documentElement.style;
  if (stack) root.setProperty("--mono-user", stack);
  else root.removeProperty("--mono-user");
}

export function loadCodeFont(): string {
  return loadStored(CODE_KEY);
}

export function saveCodeFont(input: string) {
  saveStored(CODE_KEY, input);
}

/**
 * `@font-face` rules that draw only private-use icons from each installed
 * Nerd Font. One face would stop at the first `local()` that exists, so each
 * font is its own rule and the earlier one wins when both have the glyph.
 * Normal, bold, and italic are each listed. A weight range would drop the
 * face on a WebKit that does not understand it, and then no icon would draw.
 */
export function nerdFaceCss(faces: string[][]): string {
  const rules: string[] = [];
  for (const names of faces) {
    const src = names
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => `local(${quoteFont(name)})`);
    if (!src.length) continue;
    const body = `font-family:${quoteFont(NERD_FAMILY)};src:${src.join(",")};unicode-range:${NERD_RANGE};`;
    for (const weight of ["normal", "bold"]) {
      for (const style of ["normal", "italic"]) {
        rules.push(`@font-face{${body}font-weight:${weight};font-style:${style}}`);
      }
    }
  }
  return rules.join("\n");
}

export function applyNerdFaces(faces: string[][]) {
  const css = nerdFaceCss(faces);
  const root = document.documentElement;
  let style = document.getElementById(NERD_STYLE);
  if (!css) {
    style?.remove();
    root.style.removeProperty("--nerd");
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = NERD_STYLE;
    document.head.append(style);
  }
  style.textContent = css;
  root.style.setProperty("--nerd", quoteFont(NERD_FAMILY));
}

/** Ask the desktop side which Nerd Fonts are installed and register them. */
export async function installNerdFonts(list: () => Promise<string[][]>): Promise<void> {
  try {
    applyNerdFaces(await list());
  } catch {
    /* No desktop command in tests or a plain browser. Icons stay as they are. */
  }
}

function loadStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function saveStored(key: string, input: string) {
  try {
    if (input.trim()) localStorage.setItem(key, input);
    else localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}
