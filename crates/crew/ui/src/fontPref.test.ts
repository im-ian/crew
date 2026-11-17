import { describe, expect, it } from "vitest";
import { fontNames, fontStack, missingFonts, nerdFaceCss } from "./fontPref";

describe("fontStack", () => {
  it("quotes each font and keeps the app's stack behind them", () => {
    expect(fontStack("Pretendard, Noto Sans KR")).toBe(
      '"Pretendard", "Noto Sans KR", var(--sans)',
    );
  });

  it("reads quotes already typed and leaves keywords bare", () => {
    expect(fontStack(`'Apple SD Gothic Neo', "D2Coding", sans-serif`)).toBe(
      '"Apple SD Gothic Neo", "D2Coding", sans-serif, var(--sans)',
    );
    expect(fontStack("-apple-system")).toBe("-apple-system, var(--sans)");
  });

  it("is empty when nothing is typed", () => {
    expect(fontStack("")).toBe("");
    expect(fontStack(" , ,")).toBe("");
  });

  it("keeps a typed quote inside the name", () => {
    expect(fontStack('Bad"; color: red')).toBe('"Bad\\"; color: red", var(--sans)');
  });

  it("puts the code stack behind a typed code font", () => {
    expect(fontStack("JetBrains Mono, ui-monospace", "var(--mono-builtin)")).toBe(
      '"JetBrains Mono", ui-monospace, var(--mono-builtin)',
    );
  });
});

describe("nerdFaceCss", () => {
  it("limits each installed font to private-use icons", () => {
    const css = nerdFaceCss([["Symbols Nerd Font Mono", "SymbolsNFM"], ["Hack Nerd Font"]]);
    const first = css.indexOf('local("Symbols Nerd Font Mono")');
    const second = css.indexOf('local("Hack Nerd Font")');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(css).toContain("U+E000-F8FF");
    expect(css).toContain("U+F0000-FFFFD");
    expect(css).toContain("U+100000-10FFFD");
    expect(css).toContain("font-style:normal");
    expect(css).toContain("font-style:italic");
    expect(css).not.toContain("U+0000-");
  });

  it("escapes a quote and skips an empty face", () => {
    expect(nerdFaceCss([['A"B']])).toContain('local("A\\"B")');
    expect(nerdFaceCss([[], ["  "]])).toBe("");
  });
});

describe("fontNames", () => {
  it("splits on commas and trims", () => {
    expect(fontNames(" A ,  'B C' ,")).toEqual(["A", "B C"]);
  });
});

describe("missingFonts", () => {
  // A fake measure: only Pretendard is installed, and it is wider than either fallback.
  const measure = (family: string) =>
    family.startsWith('"Pretendard"') ? 120 : family.endsWith("serif") ? 100 : 110;

  it("names the fonts that fall back", () => {
    expect(missingFonts("Pretendard, Nope Sans, serif", measure)).toEqual(["Nope Sans"]);
  });
});
