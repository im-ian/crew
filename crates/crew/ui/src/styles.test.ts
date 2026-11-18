import { describe, expect, it } from "vitest";
import source from "./styles.css?raw";

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
});
