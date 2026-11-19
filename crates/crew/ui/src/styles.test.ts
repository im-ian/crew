import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Vitest stubs a CSS import, so `?raw` arrives empty and the brace check
// would pass on nothing. Read the file the build actually ships.
const source = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/**
 * tsc and the other tests never read the stylesheet, and a brace lost while
 * merging two branches left the phone block open: Vite failed to build and
 * the phone got the desktop layout. Comments and strings are skipped.
 */
describe("styles.css", () => {
  it("closes every block it opens", () => {
    const css = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
    let depth = 0;
    let line = 1;
    for (const ch of css) {
      if (ch === "\n") line++;
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (depth < 0) throw new Error(`a block closes before it opens near line ${line}`);
    }
    expect(depth, "a block is left open").toBe(0);
  });

  it("gives the picture overlay a full screen and a finger-sized close on a phone", () => {
    const phone = source.slice(source.lastIndexOf("@media (max-width: 640px)"));
    expect(phone).toMatch(/\.img-preview\s*\{[^}]*height:\s*var\(--phone-h\)/);
    expect(phone).toMatch(/\.img-preview-close\s*\{[^}]*top:\s*calc\(8px \+ var\(--safe-top\)\)/);
    expect(phone).toMatch(/\.img-preview-close\s*\{[^}]*width:\s*44px/);
    expect(phone).toMatch(/\.img-preview-close\s*\{[^}]*height:\s*44px/);
  });
});
