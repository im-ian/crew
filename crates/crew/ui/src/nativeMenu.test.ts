import { describe, expect, it } from "vitest";
import { keepNativeMenu } from "./nativeMenu";

describe("native right click menu", () => {
  it("is kept in a text box and over selected text", () => {
    expect(keepNativeMenu(true, "")).toBe(true);
    expect(keepNativeMenu(false, "hello")).toBe(true);
  });

  it("is dropped everywhere else", () => {
    expect(keepNativeMenu(false, "")).toBe(false);
    expect(keepNativeMenu(false, "  \n")).toBe(false);
  });
});
