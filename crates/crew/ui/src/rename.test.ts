import { describe, expect, it } from "vitest";
import { commitName } from "./rename";

describe("commitName", () => {
  it("keeps a changed name", () => {
    expect(commitName("  Ada  ", "Bot")).toBe("Ada");
  });

  it("drops an empty or unchanged edit", () => {
    expect(commitName("   ", "Bot")).toBeNull();
    expect(commitName("Bot", "Bot")).toBeNull();
    expect(commitName("  Bot  ", "Bot")).toBeNull();
  });
});
