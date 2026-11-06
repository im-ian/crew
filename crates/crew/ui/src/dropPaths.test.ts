import { describe, expect, it } from "vitest";
import { dropPathsText } from "./dropPaths";

describe("dropPathsText", () => {
  it("types each path with a space after", () => {
    expect(dropPathsText(["/tmp/a.txt"])).toBe("/tmp/a.txt ");
    expect(dropPathsText(["/tmp/a.txt", "/tmp/b"])).toBe("/tmp/a.txt /tmp/b ");
  });

  it("quotes a path with whitespace", () => {
    expect(dropPathsText(["/Users/me/Application Support/x.log"])).toBe(
      '"/Users/me/Application Support/x.log" ',
    );
  });

  it("keeps a space from the word before the caret", () => {
    expect(dropPathsText(["/tmp/a"], "look at")).toBe(" /tmp/a ");
    expect(dropPathsText(["/tmp/a"], "look at ")).toBe("/tmp/a ");
  });

  it("types nothing for no paths", () => {
    expect(dropPathsText([])).toBe("");
    expect(dropPathsText([""], "x")).toBe("");
  });
});
