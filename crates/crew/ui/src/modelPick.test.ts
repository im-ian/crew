import { describe, expect, it } from "vitest";
import { modelCardMaxPx } from "./modelPick";

describe("modelCardMaxPx", () => {
  it("stops the card inside the scroller, above the field", () => {
    expect(modelCardMaxPx(300, 40)).toBe(244);
  });

  it("is zero when the field is already at the clipping edge", () => {
    expect(modelCardMaxPx(20, 40)).toBe(0);
  });
});
