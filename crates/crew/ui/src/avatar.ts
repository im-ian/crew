import { SHAPES, SWATCHES, normalizeHex, type ShapeDef, phaseOf, seededFace } from "crew-avatar";

export const AVATAR_SHAPES = [
  "circle",
  "teardrop",
  "rounded-square",
  "hexagon",
  "triangle",
  "cloud",
  "pill",
  "diamond",
  "pentagon",
  "star",
  "heart",
  "square",
  "slanted",
  "arch",
  "fan",
  "arrow",
  "semi-circle",
  "oval",
  "clam-shell",
  "gem",
  "sunny",
  "ghostish",
  "clover",
  "burst",
  "flower",
  "pixel-circle",
  "pixel-triangle",
  "bun",
  "crystal",
  "octagon",
  "shield",
  "crown",
  "cup",
  "trash",
  "bulb",
  "umbrella",
  "bell",
  "pixel-heart",
  "pixel-star",
  "pixel-diamond",
  "pixel-ghost",
  "sun",
  "crescent",
  "first-quarter",
  "full-moon",
  "last-quarter",
  "waning-crescent",
  "blossom",
  "snowflake",
  "mushroom",
  "palette",
  "brilliant",
  "emerald",
  "drop",
  "flame",
  "parchment",
  "pencil",
  "ballpoint-pen",
  "camera",
  "easel",
  "phone",
  "speech-bubble",
  "thought-bubble",
  "shout-bubble",
  "square-bubble",
  "whisper-bubble",
  "laptop",
  "terminal",
  "bug",
  "magnifier",
  "gear",
  "rocket",
  "clipboard",
  "book",
  "clapperboard",
  "hourglass",
  "envelope",
  "calendar",
  "key",
  "lock",
  "database",
  "headphones",
  "puzzle",
  "flask",
  "planet",
  "compass",
  "paper-plane",
  "leaf",
  "game-controller",
] as const;

// Faces a bot may already carry, but the picker no longer offers. They still
// draw and still count as valid, so saved faces keep their shape.
export const LEGACY_SHAPES = ["cookie", "puffy", "puffy-diamond"] as const;

export type AvatarShape =
  | (typeof AVATAR_SHAPES)[number]
  | (typeof LEGACY_SHAPES)[number];

export type ShapeGroupKey = "shapes" | "jobs" | "things" | "bubbles" | "nature" | "pixel";

/** How the picker lays the shapes out. Every shape in AVATAR_SHAPES sits in one group. */
export const AVATAR_SHAPE_GROUPS: {
  key: ShapeGroupKey;
  shapes: readonly (typeof AVATAR_SHAPES)[number][];
}[] = [
  {
    key: "shapes",
    shapes: [
      "circle",
      "oval",
      "rounded-square",
      "square",
      "pill",
      "semi-circle",
      "arch",
      "teardrop",
      "crystal",
      "triangle",
      "diamond",
      "pentagon",
      "hexagon",
      "octagon",
      "slanted",
      "arrow",
      "gem",
      "brilliant",
      "emerald",
      "fan",
      "clam-shell",
    ],
  },
  {
    key: "jobs",
    shapes: [
      "laptop",
      "terminal",
      "bug",
      "magnifier",
      "gear",
      "rocket",
      "clipboard",
      "book",
      "clapperboard",
      "pencil",
      "ballpoint-pen",
      "parchment",
      "camera",
      "easel",
      "phone",
      "headphones",
      "database",
      "flask",
      "calendar",
      "palette",
    ],
  },
  {
    key: "things",
    shapes: [
      "heart",
      "star",
      "burst",
      "cloud",
      "ghostish",
      "bun",
      "shield",
      "crown",
      "cup",
      "trash",
      "bulb",
      "umbrella",
      "bell",
      "hourglass",
      "envelope",
      "key",
      "lock",
      "puzzle",
      "compass",
      "paper-plane",
      "game-controller",
    ],
  },
  {
    key: "bubbles",
    shapes: [
      "speech-bubble",
      "thought-bubble",
      "shout-bubble",
      "square-bubble",
      "whisper-bubble",
    ],
  },
  {
    key: "nature",
    shapes: [
      "sun",
      "sunny",
      "crescent",
      "first-quarter",
      "full-moon",
      "last-quarter",
      "waning-crescent",
      "blossom",
      "flower",
      "clover",
      "snowflake",
      "mushroom",
      "drop",
      "flame",
      "leaf",
      "planet",
    ],
  },
  {
    key: "pixel",
    shapes: [
      "pixel-circle",
      "pixel-triangle",
      "pixel-heart",
      "pixel-star",
      "pixel-diamond",
      "pixel-ghost",
    ],
  },
];

// The palette, the hashing, the color rule and the animation phase all come from
// crew-avatar, so a face is drawn and picked the same way wherever it is used.
export const AVATAR_SWATCHES: string[] = [...SWATCHES];

export { normalizeHex };

const PALETTE = [
  "#5b7c99",
  "#6b8f71",
  "#8a7355",
  "#7a6b93",
  "#4f8f8a",
  "#8f6b6b",
  "#6b7a8f",
  "#8a8f5b",
];

/** FNV-1a, as in crew-avatar. Only the letter avatar's color needs it here. */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function avatarColor(id: string | undefined | null): string {
  const h = hashId(String(id || ""));
  return PALETTE[h % PALETTE.length];
}

export const avatarPhase = phaseOf;

export function initialOf(name: string | undefined | null): string {
  const s = String(name || "?").trim();
  return s ? s[0].toUpperCase() : "?";
}

export function isAvatarShape(s: string | null | undefined): s is AvatarShape {
  return (
    !!s &&
    ((AVATAR_SHAPES as readonly string[]).includes(s) ||
      (LEGACY_SHAPES as readonly string[]).includes(s))
  );
}

// Agents with no saved face hash into the first 11 shapes and 10 swatches, so
// adding shapes or swatches never reshuffles bots that were never customized.
// seededFace keeps that rule; avatar.test.ts pins the faces it gives.
export function hashedFace(id: string): { shape: AvatarShape; color: string } {
  // The first 11 shapes are all in AvatarShape; the package types the pick more widely.
  return seededFace(id) as { shape: AvatarShape; color: string };
}

export function randomFace(exclude?: {
  shape?: string | null;
  color?: string | null;
}): { shape: AvatarShape; color: string } {
  const shapes = AVATAR_SHAPES.filter((s) => s !== exclude?.shape);
  const colors = AVATAR_SWATCHES.filter(
    (c) => c.toLowerCase() !== String(exclude?.color || "").toLowerCase(),
  );
  const shapePool = shapes.length ? shapes : AVATAR_SHAPES;
  const colorPool = colors.length ? colors : AVATAR_SWATCHES;
  return {
    shape: shapePool[Math.floor(Math.random() * shapePool.length)],
    color: colorPool[Math.floor(Math.random() * colorPool.length)],
  };
}

export function resolveFace(
  id?: string | null,
  shape?: string | null,
  color?: string | null,
): { shape: AvatarShape; color: string } {
  const hashed = hashedFace(String(id || "agent"));
  const picked = isAvatarShape(shape) ? shape : hashed.shape;
  // A shape whose look depends on its color (parchment) has its own.
  const own: string | undefined = isAvatarShape(shape) ? (SHAPES[shape] as ShapeDef).color : undefined;
  return {
    shape: picked,
    color: normalizeHex(color) || own || hashed.color,
  };
}
