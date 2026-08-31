import type { AvatarShape } from "../avatar";

type Props = {
  shape: AvatarShape;
  color: string;
  className?: string;
  title?: string;
};

function eyesAt(shape: AvatarShape): { x: number; y: number } {
  switch (shape) {
    case "teardrop":
      return { x: 32, y: 27 };
    case "triangle":
      return { x: 32, y: 38 };
    case "cloud":
      return { x: 32, y: 36 };
    case "pill":
      return { x: 32, y: 32 };
    default:
      return { x: 32, y: 31 };
  }
}

function Shape({ shape, color }: { shape: AvatarShape; color: string }) {
  switch (shape) {
    case "circle":
      return <circle cx="32" cy="32" r="30" fill={color} />;
    case "teardrop":
      return (
        <path
          fill={color}
          d="M32 7c13 0 21 10.2 21 22.5 0 11.2-8.8 21-21 27.5C19.8 50.7 11 40.7 11 29.5 11 17.2 19 7 32 7z"
        />
      );
    case "rounded-square":
      return <rect x="5" y="5" width="54" height="54" rx="22" fill={color} />;
    case "hexagon":
      return (
        <path
          fill={color}
          d="M27 8.89Q32 6 37 8.89L49.52 16.11Q54.52 19 54.52 24.77V39.23Q54.52 45 49.52 47.89L37 55.11Q32 58 27 55.11L14.48 47.89Q9.48 45 9.48 39.23V24.77Q9.48 19 14.48 16.11Z"
        />
      );
    case "triangle":
      return (
        <path
          fill={color}
          d="M23.18 25.54Q32 9 40.82 25.54L48.16 39.29Q56 54 39.33 54H24.67Q8 54 15.84 39.29Z"
        />
      );
    case "cloud":
      return (
        <path
          fill={color}
          d="M18 47c-7.2 0-12-4.8-12-10.6C6 30.4 11.4 26 18 27c1.6-8.4 9.2-14 18.2-12.6 7.2 1.1 12.2 6.8 13.2 13.6 6.2.2 11.6 4.8 11.6 10.6 0 6-5.2 11.4-12.4 11.4H18z"
        />
      );
    case "pill":
      return <rect x="3" y="18" width="58" height="28" rx="14" fill={color} />;
  }
}

function Eyes({ cx, cy }: { cx: number; cy: number }) {
  const dx = 7.2;
  const w = 6;
  const h = 10.5;
  return (
    <g fill="#fff">
      <rect x={cx - dx - w / 2} y={cy - h / 2} width={w} height={h} rx={w / 2} />
      <rect x={cx + dx - w / 2} y={cy - h / 2} width={w} height={h} rx={w / 2} />
    </g>
  );
}

export function BotFace({ shape, color, className, title }: Props) {
  const eyes = eyesAt(shape);
  return (
    <svg
      className={className ? `avatar-face ${className}` : "avatar-face"}
      viewBox="0 0 64 64"
      width="100%"
      height="100%"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      overflow="visible"
    >
      {title ? <title>{title}</title> : null}
      <Shape shape={shape} color={color} />
      <Eyes cx={eyes.x} cy={eyes.y} />
    </svg>
  );
}
