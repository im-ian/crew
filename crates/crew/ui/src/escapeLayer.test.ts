import { describe, expect, it } from "vitest";
import { ESCAPE_LAYERS, escapeLayerOpen, escapeLayerSelector } from "./escapeLayer";

describe("escape layers", () => {
  it("covers the sheets Escape closes", () => {
    const selector = escapeLayerSelector();
    for (const layer of [".modal.open", ".overlay.open", ".img-preview", ".peek-room"]) {
      expect(ESCAPE_LAYERS).toContain(layer);
      expect(selector).toContain(layer);
    }
  });

  it("is open only when one of those layers is in the tree", () => {
    const root = (found: boolean) => ({
      querySelector(selector: string) {
        expect(selector).toContain(".img-preview");
        return found ? {} : null;
      },
    });
    expect(escapeLayerOpen(root(true))).toBe(true);
    expect(escapeLayerOpen(root(false))).toBe(false);
  });
});
