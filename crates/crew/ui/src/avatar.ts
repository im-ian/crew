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
] as const;

// Faces a bot may already carry, but the picker no longer offers. They still
// draw and still count as valid, so saved faces keep their shape.
export const LEGACY_SHAPES = ["cookie", "puffy", "puffy-diamond"] as const;

export type AvatarShape =
  | (typeof AVATAR_SHAPES)[number]
  | (typeof LEGACY_SHAPES)[number];

export type ShapeGroupKey = "shapes" | "things" | "pixel" | "nature";

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
      "fan",
      "clam-shell",
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
      "palette",
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
    ],
  },
];

export const AVATAR_SWATCHES = [
  "#ff8a3d",
  "#4da3ff",
  "#2ec4b6",
  "#8e8e93",
  "#ff5a5a",
  "#7dcc5e",
  "#ff7aad",
  "#9b7dff",
  "#ffb347",
  "#3a3a3c",
  "#ffcc37",
  "#64d2ff",
  "#5e5ce6",
  "#ff375f",
  "#bf5af2",
  "#a2845e",
];

// Agents with no saved face keep hashing into the original set. Adding a shape
// or a swatch must not reshuffle bots that were never customized.
const HASH_SHAPES = AVATAR_SHAPES.slice(0, 11);
const HASH_SWATCHES = AVATAR_SWATCHES.slice(0, 10);

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

export function avatarPhase(id: string | undefined | null): number {
  return (hashId(String(id || "")) % 83) / 10;
}

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

export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  const hex = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const [a, b, c] = hex.split("");
    return `#${a}${a}${b}${b}${c}${c}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex}`.toLowerCase();
  }
  return null;
}

export function hashedFace(id: string): { shape: AvatarShape; color: string } {
  const h = hashId(id);
  return {
    shape: HASH_SHAPES[h % HASH_SHAPES.length],
    color: HASH_SWATCHES[Math.floor(h / HASH_SHAPES.length) % HASH_SWATCHES.length],
  };
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
  return {
    shape: isAvatarShape(shape) ? shape : hashed.shape,
    color: normalizeHex(color) || hashed.color,
  };
}
