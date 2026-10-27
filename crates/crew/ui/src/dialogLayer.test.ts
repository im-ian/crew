import { describe, expect, it } from "vitest";
import { backdropPress } from "./dialogLayer";

describe("backdropPress", () => {
  it("closes the dialog when nothing is popped over it", () => {
    expect(
      backdropPress({
        onBackdrop: true,
        onSelect: false,
        popoverOpen: false,
        selectMenuOpen: false,
      }),
    ).toBe("close");
  });

  it("keeps the dialog when a picker is open", () => {
    expect(
      backdropPress({
        onBackdrop: true,
        onSelect: false,
        popoverOpen: true,
        selectMenuOpen: false,
      }),
    ).toBe("keep");
  });

  it("keeps the dialog when a native select menu is open", () => {
    expect(
      backdropPress({
        onBackdrop: true,
        onSelect: false,
        popoverOpen: false,
        selectMenuOpen: true,
      }),
    ).toBe("keep");
  });

  it("arms the select instead of closing", () => {
    expect(
      backdropPress({
        onBackdrop: false,
        onSelect: true,
        popoverOpen: false,
        selectMenuOpen: false,
      }),
    ).toBe("arm");
  });

  it("ignores a press inside the dialog", () => {
    expect(
      backdropPress({
        onBackdrop: false,
        onSelect: false,
        popoverOpen: true,
        selectMenuOpen: false,
      }),
    ).toBe("ignore");
  });
});
