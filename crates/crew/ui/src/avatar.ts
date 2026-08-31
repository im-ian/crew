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
] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];

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
];

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
  return !!s && (AVATAR_SHAPES as readonly string[]).includes(s);
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
    shape: AVATAR_SHAPES[h % AVATAR_SHAPES.length],
    color: AVATAR_SWATCHES[Math.floor(h / AVATAR_SHAPES.length) % AVATAR_SWATCHES.length],
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
