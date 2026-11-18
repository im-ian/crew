import { describe, expect, it } from "vitest";
import { cleanUserName } from "./userName";

describe("cleanUserName", () => {
  it("is empty when nothing but space is typed", () => {
    expect(cleanUserName("")).toBe("");
    expect(cleanUserName("  \n\t ")).toBe("");
  });

  it("keeps one trimmed line", () => {
    expect(cleanUserName("  대호 ")).toBe("대호");
    expect(cleanUserName("Dae\nHo\t Im")).toBe("Dae Ho Im");
  });

  it("stops at 40 letters, as the daemon does", () => {
    expect(Array.from(cleanUserName("가".repeat(100)))).toHaveLength(40);
  });
});
