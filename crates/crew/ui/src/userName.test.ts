import { describe, expect, it } from "vitest";
import { cleanUserName } from "./userName";

describe("cleanUserName", () => {
  it("is empty when nothing but space is typed", () => {
    expect(cleanUserName("")).toBe("");
    expect(cleanUserName("  \n\t ")).toBe("");
  });

  it("keeps one trimmed line", () => {
    expect(cleanUserName("  민수 ")).toBe("민수");
    expect(cleanUserName("Kim\nLee\t Park")).toBe("Kim Lee Park");
  });

  it("stops at 40 letters, as the daemon does", () => {
    expect(Array.from(cleanUserName("가".repeat(100)))).toHaveLength(40);
  });
});
