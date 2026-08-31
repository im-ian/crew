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
      return { x: 32, y: 26 };
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
          d="M32 6c14 0 22 11 22 23 0 12-10 22-22 33C20 51 10 41 10 29 10 17 18 6 32 6z"
        />
      );
    case "rounded-square":
      return <rect x="5" y="5" width="54" height="54" rx="16" fill={color} />;
    case "hexagon":
      return (
        <path
          fill={color}
          stroke={color}
          strokeWidth="3"
          strokeLinejoin="round"
          d="M32 6.5 55.5 19.5v25L32 57.5 8.5 44.5v-25z"
        />
      );
    case "triangle":
      return (
        <path
          fill={color}
          stroke={color}
          strokeWidth="5.5"
          strokeLinejoin="round"
          d="M32 11 55 53H9z"
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
  const dx = 7.6;
  const w = 5.4;
  const h = 13.2;
  const tilt = 17;
  return (
    <g fill="#fff">
      <rect
        x={cx - dx - w / 2}
        y={cy - h / 2}
        width={w}
        height={h}
        rx={w / 2}
        transform={`rotate(${tilt} ${cx - dx} ${cy})`}
      />
      <rect
        x={cx + dx - w / 2}
        y={cy - h / 2}
        width={w}
        height={h}
        rx={w / 2}
        transform={`rotate(${-tilt} ${cx + dx} ${cy})`}
      />
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
