import { describe, expect, it } from "vitest";
import { fontNames, fontStack, missingFonts } from "./fontPref";

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
