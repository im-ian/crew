import { describe, expect, it } from "vitest";
import { applyFontSize, FONT_SIZES, fontScale, fontSizeOf } from "./fontSize";

function fakeRoot() {
  const props = new Map<string, string>();
  return {
    props,
    style: {
      setProperty: (name: string, value: string | null) => {
        props.set(name, value ?? "");
      },
      removeProperty: (name: string) => {
        const was = props.get(name) ?? "";
        props.delete(name);
        return was;
      },
    },
  };
}

describe("fontSizeOf", () => {
  it("reads each saved step back", () => {
    for (const size of FONT_SIZES) expect(fontSizeOf(size)).toBe(size);
  });

  it("falls back to the default for missing or junk", () => {
    expect(fontSizeOf(null)).toBe("default");
    expect(fontSizeOf("")).toBe("default");
    expect(fontSizeOf("huge")).toBe("default");
    expect(fontSizeOf("1.2")).toBe("default");
  });
});

describe("fontScale", () => {
  it("keeps today's size as the default", () => {
    expect(fontScale("default")).toBe(1);
  });

  it("grows in order, 13 to 19px of a 15px base", () => {
    const px = FONT_SIZES.map((size) => Math.round(fontScale(size) * 15));
    expect(px).toEqual([13, 15, 17, 19]);
  });
});

describe("applyFontSize", () => {
  it("sets the scale CSS reads, and clears it at the default", () => {
    const root = fakeRoot();
    applyFontSize("large", root);
    expect(Number(root.props.get("--chat-scale"))).toBeCloseTo(17 / 15);
    applyFontSize("default", root);
    expect(root.props.has("--chat-scale")).toBe(false);
  });
});
