import { describe, expect, it } from "vitest";
import { parseThemePref } from "./theme";

describe("parseThemePref", () => {
  it("keeps every known theme, glass included", () => {
    expect(parseThemePref("dark")).toBe("dark");
    expect(parseThemePref("light")).toBe("light");
    expect(parseThemePref("system")).toBe("system");
    expect(parseThemePref("glass")).toBe("glass");
  });

  it("falls back to dark for anything else", () => {
    expect(parseThemePref(null)).toBe("dark");
    expect(parseThemePref("blueprint")).toBe("dark");
  });
});
