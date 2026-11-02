import { describe, expect, it } from "vitest";
import { chatWidthOf } from "./chatWidth";

describe("chatWidthOf", () => {
  it("reads narrow only when it was saved", () => {
    expect(chatWidthOf("narrow")).toBe("narrow");
    expect(chatWidthOf("full")).toBe("full");
    expect(chatWidthOf(null)).toBe("full");
    expect(chatWidthOf("wide")).toBe("full");
  });
});
