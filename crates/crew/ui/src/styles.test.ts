import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DANCE_MS } from "./botSignals";

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

  it("keeps the model line on a phone, under the name, off the header buttons", () => {
    const phone = source.slice(source.lastIndexOf("@media (max-width: 640px)"));
    const run = phone.match(/header \.head-run\s*\{[^}]*\}/);
    expect(run, "the phone rule for .head-run").not.toBeNull();
    expect(run![0]).not.toMatch(/display:\s*none/);
    expect(run![0]).toMatch(/order:\s*2/);
    expect(run![0]).toMatch(/flex:\s*1 0 100%/);
    expect(run![0]).toMatch(/max-width:\s*100%/);
    // The name and the status share the first line; the run line takes the next.
    // Scoped to the chat header, so a lead row's status is left alone.
    expect(phone).toMatch(/header \.head-identity\s*\{[^}]*flex-wrap:\s*wrap/);
    const status = phone.match(/header \.head-status\s*\{[^}]*\}/);
    expect(status, "the phone rule for .head-status").not.toBeNull();
    expect(status![0]).toMatch(/order:\s*1/);
    expect(status![0]).toMatch(/flex:\s*1 1 0/);
    expect(phone).toMatch(/header \.head-identity:has\(\.head-status\) \.who-btn\s*\{[^}]*max-width:\s*calc\(100% - 4\.5em\)/);
    // Header padding is the safe-area inset's neighbor. This change does not touch it.
    expect(phone).toMatch(/header\s*\{[^}]*padding:\s*var\(--space-6\) var\(--space-8\) 0 var\(--space-6\)/);
  });

  it("gives the picture overlay a full screen and a finger-sized close on a phone", () => {
    const phone = source.slice(source.lastIndexOf("@media (max-width: 640px)"));
    expect(phone).toMatch(/\.img-preview\s*\{[^}]*height:\s*var\(--phone-h\)/);
    expect(phone).toMatch(/\.img-preview-close\s*\{[^}]*top:\s*calc\(8px \+ var\(--safe-top\)\)/);
    expect(phone).toMatch(/\.img-preview-close\s*\{[^}]*width:\s*44px/);
    expect(phone).toMatch(/\.img-preview-close\s*\{[^}]*height:\s*44px/);
  });
  it("plays the success dance a few times, never as a loop, then stops for the calm smile", () => {
    const dance = source.match(/\.avatar-face\.is-success\s*\{[^}]*animation:\s*avatar-cheer\s+([\d.]+)s[^}]*\}/);
    expect(dance, "the success rule").not.toBeNull();
    const rule = dance![0];
    expect(rule).toContain("animation-iteration-count: var(--mood-count, 3)");
    // The JS moment that swaps in calm has to match the passes the CSS plays.
    expect(Math.round(Number(dance![1]) * 3 * 1000)).toBeLessThanOrEqual(DANCE_MS);
    expect(DANCE_MS).toBeLessThan(Number(dance![1]) * 3 * 1000 + 300);
    // Nothing else (the phone block included) makes the dance repeat again.
    expect(source.match(/\.avatar-face\.is-success\s*\{[^}]*animation/g)).toHaveLength(1);
    expect(source).not.toMatch(/is-success[^{]*\{[^}]*infinite/);
    // Calm wears the same eyes and carries no animation of its own.
    expect(source).toMatch(/\.avatar-face\.is-calm \.avatar-pill/);
    expect(source).toMatch(/\.avatar-face\.is-calm \.avatar-arc/);
    expect(source).not.toMatch(/\.avatar-face\.is-calm[^{]*\{[^}]*animation/);
  });

  it("keeps the success dance off for people who ask for less motion", () => {
    const reduced = source.slice(source.indexOf("@media (prefers-reduced-motion: reduce)", source.indexOf("@keyframes avatar-snooze")));
    expect(reduced.slice(0, reduced.indexOf("}"))).toContain(".avatar-face.is-success,");
  });
});
