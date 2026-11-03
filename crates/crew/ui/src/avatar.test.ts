import { describe, expect, it } from "vitest";
import {
  AVATAR_SHAPES,
  AVATAR_SHAPE_GROUPS,
  LEGACY_SHAPES,
  hashedFace,
  isAvatarShape,
  resolveFace,
} from "./avatar";
import { artFace } from "./faceArt";
import { extraFace } from "./faceGeometry";

// Shapes BotFace draws with its own markup rather than a stored outline.
const CORE = [
  "circle",
  "teardrop",
  "rounded-square",
  "hexagon",
  "triangle",
  "cloud",
  "pill",
  "diamond",
  "pentagon",
  "heart",
];

describe("avatar shapes", () => {
  it("puts every shape the picker offers in exactly one group", () => {
    const grouped = AVATAR_SHAPE_GROUPS.flatMap((g) => [...g.shapes]);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...AVATAR_SHAPES].sort());
  });

  it("has a drawing for every shape, including the ones the picker dropped", () => {
    for (const shape of [...AVATAR_SHAPES, ...LEGACY_SHAPES]) {
      const drawn = CORE.includes(shape) || !!artFace(shape) || !!extraFace(shape);
      expect(drawn, shape).toBe(true);
    }
  });

  it("keeps a saved face on a shape the picker no longer offers", () => {
    for (const shape of LEGACY_SHAPES) {
      expect(isAvatarShape(shape)).toBe(true);
      expect(resolveFace("bot", shape, "#ff8a3d").shape).toBe(shape);
    }
    expect(AVATAR_SHAPES as readonly string[]).not.toContain("cookie");
    expect(isAvatarShape("banana")).toBe(false);
  });

  it("keeps the face a bot gets from its name", () => {
    // Taken from before the new shapes. Adding a shape must not reshuffle bots
    // that were never customized.
    const before: [string, string, string][] = [
      ["impl", "rounded-square", "#3a3a3c"],
      ["review", "rounded-square", "#8e8e93"],
      ["design", "pentagon", "#4da3ff"],
      ["brief", "teardrop", "#ffb347"],
      ["infra", "star", "#ffb347"],
      ["laya", "rounded-square", "#2ec4b6"],
      ["crew-mvswe6s4", "diamond", "#8e8e93"],
      ["bot-mviu7jiz", "teardrop", "#7dcc5e"],
      ["245-mvsvat2h", "pill", "#ff5a5a"],
      ["agent", "pentagon", "#ff5a5a"],
    ];
    for (const [id, shape, color] of before) {
      expect(hashedFace(id), id).toEqual({ shape, color });
    }
  });

  it("keeps the eyes inside the shape's box", () => {
    for (const shape of AVATAR_SHAPES) {
      const art = artFace(shape);
      if (!art) continue;
      const { x, y, w, h } = art.box;
      const { eyes } = art;
      expect(eyes.x, shape).toBeGreaterThan(x);
      expect(eyes.x, shape).toBeLessThan(x + w);
      expect(eyes.y, shape).toBeGreaterThan(y);
      expect(eyes.y, shape).toBeLessThan(y + h);
    }
  });

  it("paints through currentColor, with only black or white tints besides", () => {
    // A mark may darken or lighten the body (craters, the ghost half) but never
    // bring a color of its own, so a bot's color still decides the whole face.
    for (const shape of AVATAR_SHAPES) {
      const art = artFace(shape);
      if (!art) continue;
      expect(art.markup, shape).toContain("currentColor");
      const fixed = art.markup.match(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/gi) ?? [];
      for (const color of fixed) {
        expect(["#000", "#fff"], `${shape} ${color}`).toContain(color.toLowerCase());
      }
    }
  });
});
