// Faces drawn as a body plus marks (rays, craters, a ghost half) rather than one
// outline, and the shapes that replace an older drawing. `markup` is SVG for the
// 64 box. It paints with `currentColor`, which BotFace sets on the group. The
// `cel-*` classes animate in styles.css. `box`, `ink` and `eyes` mean the same as
// in faceGeometry.ts; `eyes.dx` narrows the pair where the lit part is thin.
export type ArtFace = {
  markup: string;
  box: { x: number; y: number; w: number; h: number; opticalX?: number; opticalY?: number };
  ink: number;
  eyes: { x: number; y: number; dx?: number };
};

const ART = {
  crystal: {
    markup: `<path fill="currentColor" d="M32 2Q43 21 62 32Q43 43 32 62Q21 43 2 32Q21 21 32 2Z"/>`,
    box: { x: 2, y: 2, w: 60, h: 60 },
    ink: 1,
    eyes: { x: 32, y: 32 },
  },
  octagon: {
    markup: `<path fill="currentColor" d="M60.64 40.66Q60.64 43.86 58.38 46.13L46.13 58.38Q43.86 60.64 40.66 60.64L23.34 60.64Q20.14 60.64 17.87 58.38L5.62 46.13Q3.36 43.86 3.36 40.66L3.36 23.34Q3.36 20.14 5.62 17.87L17.87 5.62Q20.14 3.36 23.34 3.36L40.66 3.36Q43.86 3.36 46.13 5.62L58.38 17.87Q60.64 20.14 60.64 23.34Z"/>`,
    box: { x: 3.36, y: 3.36, w: 57.28, h: 57.28 },
    ink: 1,
    eyes: { x: 32, y: 31 },
  },
  shield: {
    markup: `<path fill="currentColor" d="M8 6Q8 4 10 4H54Q56 4 56 6V32C56 46 44 56 32 61C20 56 8 46 8 32Z"/>`,
    box: { x: 8, y: 4, w: 48, h: 57 },
    ink: 1,
    eyes: { x: 32, y: 27 },
  },
  crown: {
    markup: `<path fill="currentColor" d="M10.00 56.00Q6 56 6.00 52.00L6.00 28.00Q6 24 8.83 26.83L18.59 36.59Q20 38 20.79 36.16L30.42 13.68Q32 10 33.58 13.68L43.21 36.16Q44 38 45.41 36.59L55.17 26.83Q58 24 58.00 28.00L58.00 52.00Q58 56 54.00 56.00Z"/>`,
    box: { x: 6, y: 11.84, w: 52, h: 44.16 },
    ink: 1,
    eyes: { x: 32, y: 45 },
  },
  cup: {
    markup: `<g fill="currentColor"><path fill-rule="evenodd" d="M56 33A11 11 0 1 0 34 33A11 11 0 1 0 56 33ZM50.5 33A5.5 5.5 0 1 1 39.5 33A5.5 5.5 0 1 1 50.5 33Z"/><rect x="6" y="12" width="36" height="44" rx="9"/></g>`,
    box: { x: 6, y: 12, w: 50, h: 44 },
    ink: 1,
    eyes: { x: 24, y: 32 },
  },
  trash: {
    markup: `<g fill="currentColor"><rect x="24" y="4" width="16" height="7" rx="3"/><rect x="6" y="10" width="52" height="7" rx="3.5"/><path d="M11 19.5H53L50 55Q49.6 59 45.5 59H18.5Q14.4 59 14 55Z"/></g><path d="M17 28V51M47 28V51" fill="none" stroke="#000" stroke-opacity="0.22" stroke-width="2.6" stroke-linecap="round"/>`,
    box: { x: 6, y: 4, w: 52, h: 55 },
    ink: 1,
    eyes: { x: 32, y: 35 },
  },
  bulb: {
    markup: `<g fill="currentColor"><circle cx="32" cy="26" r="21"/><path d="M21 38H43L41 50H23Z"/><rect x="23" y="51" width="18" height="4" rx="2"/><rect x="25" y="56.5" width="14" height="4" rx="2"/></g>`,
    box: { x: 11, y: 5, w: 42, h: 55.5 },
    ink: 1,
    eyes: { x: 32, y: 26 },
  },
  umbrella: {
    markup: `<g fill="currentColor"><path d="M4 36A28 30 0 0 1 60 36Q53 31 46 36Q39 31 32 36Q25 31 18 36Q11 31 4 36Z"/><rect x="30.3" y="35" width="3.4" height="20"/><path d="M33.7 55A6.2 6.2 0 0 1 21.3 55H24.7A2.8 2.8 0 0 0 30.3 55Z"/></g>`,
    box: { x: 4, y: 6, w: 56, h: 55.2 },
    ink: 1,
    eyes: { x: 32, y: 21 },
  },
  bell: {
    markup: `<g fill="currentColor"><circle cx="32" cy="6" r="3.6"/><path d="M10 44C10 20 20 9 32 9C44 9 54 20 54 44L58 50Q58 52.5 55.5 52.5H8.5Q6 52.5 6 50Z"/><circle cx="32" cy="58" r="4.6"/></g>`,
    box: { x: 6, y: 2.4, w: 52, h: 60.2 },
    ink: 1,
    eyes: { x: 32, y: 30 },
  },
  star: {
    markup: `<path fill="currentColor" d="M27.76 11.19Q32.00 5.00 36.24 11.19L38.55 14.56Q42.23 19.92 48.46 21.76L52.39 22.92Q59.58 25.04 55.01 30.98L52.51 34.23Q48.55 39.38 48.73 45.87L48.84 49.96Q49.05 57.46 41.98 54.95L38.12 53.58Q32.00 51.40 25.88 53.58L22.02 54.95Q14.95 57.46 15.16 49.96L15.27 45.87Q15.45 39.38 11.49 34.23L8.99 30.98Q4.42 25.04 11.61 22.92L15.54 21.76Q21.77 19.92 25.45 14.56Z"/>`,
    box: { x: 7.22, y: 8.09, w: 49.56, h: 47.49, opticalY: 1.2 },
    ink: 0.95,
    eyes: { x: 32, y: 35.6 },
  },
  "pixel-heart": {
    markup: `<path fill="currentColor" d="M11.30 6.70h14.05v4.85h-14.05zM38.90 6.70h14.05v4.85h-14.05zM6.70 11.30h23.25v4.85h-23.25zM34.30 11.30h23.25v4.85h-23.25zM2.10 15.90h60.05v4.85h-60.05zM2.10 20.50h60.05v4.85h-60.05zM2.10 25.10h60.05v4.85h-60.05zM6.70 29.70h50.85v4.85h-50.85zM11.30 34.30h41.65v4.85h-41.65zM15.90 38.90h32.45v4.85h-32.45zM20.50 43.50h23.25v4.85h-23.25zM25.10 48.10h14.05v4.85h-14.05zM29.70 52.70h4.85v4.85h-4.85z"/>`,
    box: { x: 2.1, y: 6.7, w: 59.8, h: 50.6 },
    ink: 1,
    eyes: { x: 32, y: 22.8 },
  },
  "pixel-star": {
    markup: `<path fill="currentColor" d="M29.27 2.02h5.70v5.70h-5.70zM29.27 7.47h5.70v5.70h-5.70zM23.82 12.92h16.60v5.70h-16.60zM2.02 18.38h60.20v5.70h-60.20zM7.47 23.82h49.30v5.70h-49.30zM12.92 29.27h38.40v5.70h-38.40zM12.92 34.73h38.40v5.70h-38.40zM7.47 40.17h49.30v5.70h-49.30zM7.47 45.63h22.05v5.70h-22.05zM34.73 45.63h22.05v5.70h-22.05zM7.47 51.08h16.60v5.70h-16.60zM40.17 51.08h16.60v5.70h-16.60zM7.47 56.52h5.70v5.70h-5.70zM51.08 56.52h5.70v5.70h-5.70z"/>`,
    box: { x: 2.02, y: 2.02, w: 59.95, h: 59.95 },
    ink: 1,
    eyes: { x: 32, y: 29.28 },
  },
  "pixel-diamond": {
    markup: `<path fill="currentColor" d="M29.27 2.02h5.70v5.70h-5.70zM23.82 7.47h16.60v5.70h-16.60zM18.38 12.92h27.50v5.70h-27.50zM12.92 18.38h38.40v5.70h-38.40zM7.47 23.82h49.30v5.70h-49.30zM2.02 29.27h60.20v5.70h-60.20zM7.47 34.73h49.30v5.70h-49.30zM12.92 40.17h38.40v5.70h-38.40zM18.38 45.63h27.50v5.70h-27.50zM23.82 51.08h16.60v5.70h-16.60zM29.27 56.52h5.70v5.70h-5.70z"/>`,
    box: { x: 2.02, y: 2.02, w: 59.95, h: 59.95 },
    ink: 1,
    eyes: { x: 32, y: 32 },
  },
  "pixel-ghost": {
    markup: `<path fill="currentColor" d="M18.38 2.02h27.50v5.70h-27.50zM7.47 7.47h49.30v5.70h-49.30zM2.02 12.92h60.20v5.70h-60.20zM2.02 18.38h60.20v5.70h-60.20zM2.02 23.82h60.20v5.70h-60.20zM2.02 29.27h60.20v5.70h-60.20zM2.02 34.73h60.20v5.70h-60.20zM2.02 40.17h60.20v5.70h-60.20zM2.02 45.63h60.20v5.70h-60.20zM2.02 51.08h16.60v5.70h-16.60zM23.82 51.08h16.60v5.70h-16.60zM45.63 51.08h16.60v5.70h-16.60zM2.02 56.52h16.60v5.70h-16.60zM23.82 56.52h16.60v5.70h-16.60zM45.63 56.52h16.60v5.70h-16.60z"/>`,
    box: { x: 2.02, y: 2.02, w: 59.95, h: 59.95 },
    ink: 1,
    eyes: { x: 32, y: 26.55 },
  },
  sun: {
    markup: `<g class="cel-spin" stroke="currentColor"><line x1="32.00" y1="6.80" x2="32.00" y2="4.30" stroke-width="5" stroke-linecap="round"/><line x1="44.60" y1="10.18" x2="45.05" y2="9.40" stroke-width="4" stroke-linecap="round"/><line x1="53.82" y1="19.40" x2="55.99" y2="18.15" stroke-width="5" stroke-linecap="round"/><line x1="57.20" y1="32.00" x2="58.10" y2="32.00" stroke-width="4" stroke-linecap="round"/><line x1="53.82" y1="44.60" x2="55.99" y2="45.85" stroke-width="5" stroke-linecap="round"/><line x1="44.60" y1="53.82" x2="45.05" y2="54.60" stroke-width="4" stroke-linecap="round"/><line x1="32.00" y1="57.20" x2="32.00" y2="59.70" stroke-width="5" stroke-linecap="round"/><line x1="19.40" y1="53.82" x2="18.95" y2="54.60" stroke-width="4" stroke-linecap="round"/><line x1="10.18" y1="44.60" x2="8.01" y2="45.85" stroke-width="5" stroke-linecap="round"/><line x1="6.80" y1="32.00" x2="5.90" y2="32.00" stroke-width="4" stroke-linecap="round"/><line x1="10.18" y1="19.40" x2="8.01" y2="18.15" stroke-width="5" stroke-linecap="round"/><line x1="19.40" y1="10.18" x2="18.95" y2="9.40" stroke-width="4" stroke-linecap="round"/></g><circle class="cel-pulse" cx="32" cy="32" r="19.6" fill="currentColor"/>`,
    box: { x: 2, y: 2, w: 60, h: 60 },
    ink: 1,
    eyes: { x: 31.9, y: 30.4 },
  },
  crescent: {
    markup: `<circle class="cel-dark" cx="32" cy="32" r="30" fill="currentColor"/><path fill="currentColor" d="M11.44 10.15A30 30 0 1 1 11.44 53.85A22 22 0 1 0 11.44 10.15Z"/>`,
    box: { x: 2, y: 2, w: 60, h: 60 },
    ink: 0.93,
    eyes: { x: 48.2, y: 30.2, dx: 5 },
  },
  "first-quarter": {
    markup: `<circle class="cel-dark" cx="32" cy="32" r="30" fill="currentColor"/><path fill="currentColor" d="M32 2A30 30 0 0 1 32 62Z"/>`,
    box: { x: 2, y: 2, w: 60, h: 60 },
    ink: 0.94,
    eyes: { x: 45.4, y: 30 },
  },
  "full-moon": {
    markup: `<circle cx="32" cy="32" r="30" fill="currentColor"/><g fill="#000"><circle class="cel-crater" cx="48.5" cy="44" r="6.2"/><circle class="cel-crater" cx="14.5" cy="43" r="4.4"/><circle class="cel-crater" cx="47" cy="16.5" r="3.4"/></g>`,
    box: { x: 2, y: 2, w: 60, h: 60 },
    ink: 0.94,
    eyes: { x: 31.9, y: 29.9 },
  },
  "last-quarter": {
    markup: `<circle class="cel-dark" cx="32" cy="32" r="30" fill="currentColor"/><path fill="currentColor" d="M32 2A30 30 0 0 0 32 62Z"/>`,
    box: { x: 2, y: 2, w: 60, h: 60 },
    ink: 0.94,
    eyes: { x: 18.6, y: 30 },
  },
  "waning-crescent": {
    markup: `<circle class="cel-dark" cx="32" cy="32" r="30" fill="currentColor"/><path fill="currentColor" d="M52.56 10.15A30 30 0 1 0 52.56 53.85A22 22 0 1 1 52.56 10.15Z"/>`,
    box: { x: 2, y: 2, w: 60, h: 60 },
    ink: 0.93,
    eyes: { x: 15.8, y: 30.2, dx: 5 },
  },
  blossom: {
    markup: `<g class="cel-pulse"><circle cx="32.00" cy="14.50" r="12.5" fill="currentColor"/><circle cx="48.64" cy="26.59" r="12.5" fill="currentColor"/><circle cx="42.29" cy="46.16" r="12.5" fill="currentColor"/><circle cx="21.71" cy="46.16" r="12.5" fill="currentColor"/><circle cx="15.36" cy="26.59" r="12.5" fill="currentColor"/><circle cx="32" cy="32" r="14" fill="currentColor"/></g>`,
    box: { x: 2.9, y: 2, w: 58.2, h: 56.7 },
    ink: 1,
    eyes: { x: 32, y: 32 },
  },
  snowflake: {
    markup: `<g fill="currentColor"><g transform="translate(32 32) rotate(0)"><path d="M-3.20 -13.00Q-5.2 -13 -4.64 -14.92L-1.28 -26.58Q0 -31 1.28 -26.58L4.64 -14.92Q5.2 -13 3.20 -13.00Z"/><g transform="translate(0 -19.5)"><path transform="rotate(55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/><path transform="rotate(-55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/></g></g><g transform="translate(32 32) rotate(60)"><path d="M-3.20 -13.00Q-5.2 -13 -4.64 -14.92L-1.28 -26.58Q0 -31 1.28 -26.58L4.64 -14.92Q5.2 -13 3.20 -13.00Z"/><g transform="translate(0 -19.5)"><path transform="rotate(55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/><path transform="rotate(-55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/></g></g><g transform="translate(32 32) rotate(120)"><path d="M-3.20 -13.00Q-5.2 -13 -4.64 -14.92L-1.28 -26.58Q0 -31 1.28 -26.58L4.64 -14.92Q5.2 -13 3.20 -13.00Z"/><g transform="translate(0 -19.5)"><path transform="rotate(55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/><path transform="rotate(-55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/></g></g><g transform="translate(32 32) rotate(180)"><path d="M-3.20 -13.00Q-5.2 -13 -4.64 -14.92L-1.28 -26.58Q0 -31 1.28 -26.58L4.64 -14.92Q5.2 -13 3.20 -13.00Z"/><g transform="translate(0 -19.5)"><path transform="rotate(55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/><path transform="rotate(-55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/></g></g><g transform="translate(32 32) rotate(240)"><path d="M-3.20 -13.00Q-5.2 -13 -4.64 -14.92L-1.28 -26.58Q0 -31 1.28 -26.58L4.64 -14.92Q5.2 -13 3.20 -13.00Z"/><g transform="translate(0 -19.5)"><path transform="rotate(55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/><path transform="rotate(-55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/></g></g><g transform="translate(32 32) rotate(300)"><path d="M-3.20 -13.00Q-5.2 -13 -4.64 -14.92L-1.28 -26.58Q0 -31 1.28 -26.58L4.64 -14.92Q5.2 -13 3.20 -13.00Z"/><g transform="translate(0 -19.5)"><path transform="rotate(55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/><path transform="rotate(-55)" d="M-2.40 0.00Q-3.6 0 -3.24 -1.15L-0.96 -8.45Q0 -11.5 0.96 -8.45L3.24 -1.15Q3.6 0 2.40 0.00Z"/></g></g><path d="M28.54 16.00Q32 14 35.46 16.00L44.12 21.00Q47.59 23 47.59 27.00L47.59 37.00Q47.59 41 44.12 43.00L35.46 48.00Q32 50 28.54 48.00L19.88 43.00Q16.41 41 16.41 37.00L16.41 27.00Q16.41 23 19.88 21.00Z"/></g>`,
    box: { x: 2.03, y: 3.21, w: 59.94, h: 57.58 },
    ink: 1,
    eyes: { x: 32, y: 32 },
  },
  mushroom: {
    markup: `<g fill="currentColor"><path d="M3 38C3 18 15 5 32 5C49 5 61 18 61 38Q61 45 54 45H10Q3 45 3 38Z"/><rect x="19" y="40" width="26" height="20" rx="10"/></g>`,
    box: { x: 3, y: 5, w: 58, h: 55 },
    ink: 1,
    eyes: { x: 32, y: 26 },
  },
} satisfies Record<string, ArtFace>;

export type ArtShape = keyof typeof ART;

export const ART_FACES: Record<ArtShape, ArtFace> = ART;

export const ART_BOXES = Object.fromEntries(
  (Object.keys(ART) as ArtShape[]).map((shape) => [shape, ART[shape].box]),
) as { [K in ArtShape]: ArtFace["box"] };

export const ART_INKS = Object.fromEntries(
  (Object.keys(ART) as ArtShape[]).map((shape) => [shape, ART[shape].ink]),
) as { [K in ArtShape]: number };

export function artFace(shape: string): ArtFace | undefined {
  if (Object.prototype.hasOwnProperty.call(ART, shape)) {
    return ART[shape as ArtShape];
  }
  return undefined;
}
