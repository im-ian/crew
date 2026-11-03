import { describe, expect, it } from "vitest";
import { galleryExtra, imageStep } from "./imageAlbum";

describe("galleryExtra", () => {
  it("hides nothing until the row is past five", () => {
    expect(galleryExtra(1)).toBe(0);
    expect(galleryExtra(5)).toBe(0);
    expect(galleryExtra(6)).toBe(1);
    expect(galleryExtra(8)).toBe(3);
  });
});

describe("imageStep", () => {
  it("moves with the arrow keys and stays at the ends", () => {
    expect(imageStep("ArrowRight", 0, 4)).toBe(1);
    expect(imageStep("ArrowDown", 1, 4)).toBe(2);
    expect(imageStep("ArrowLeft", 2, 4)).toBe(1);
    expect(imageStep("ArrowUp", 0, 4)).toBe(0);
    expect(imageStep("ArrowRight", 3, 4)).toBe(3);
  });

  it("ignores other keys and a single picture", () => {
    expect(imageStep("Escape", 0, 4)).toBeNull();
    expect(imageStep("ArrowRight", 0, 1)).toBeNull();
  });
});
