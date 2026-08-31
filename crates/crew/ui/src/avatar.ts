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

export function avatarColor(id: string | undefined | null): string {
  let h = 2166136261;
  const s = String(id || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function initialOf(name: string | undefined | null): string {
  const s = String(name || "?").trim();
  return s ? s[0].toUpperCase() : "?";
}
