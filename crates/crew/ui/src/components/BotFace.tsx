import type { CSSProperties } from "react";
import { avatarPhase, type AvatarShape } from "../avatar";
import type { AgentStatus } from "../types";

type Props = {
  shape: AvatarShape;
  color: string;
  className?: string;
  title?: string;
  status?: AgentStatus | null;
  id?: string | null;
};

function eyesAt(shape: AvatarShape): { x: number; y: number } {
  switch (shape) {
    case "teardrop":
      return { x: 32, y: 28 };
    case "triangle":
      return { x: 32, y: 36 };
    case "cloud":
      return { x: 32, y: 34 };
    case "pill":
      return { x: 32, y: 32 };
    case "heart":
      return { x: 32, y: 30 };
    case "star":
      return { x: 32, y: 33 };
    case "pentagon":
      return { x: 32, y: 34 };
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
          d="M32 6C46 6 56 18 56 31C56 42 44 51 32 57C20 51 8 42 8 31C8 18 18 6 32 6Z"
        />
      );
    case "rounded-square":
      return <rect x="3" y="3" width="58" height="58" rx="21" fill={color} />;
    case "hexagon":
      return (
        <path
          fill={color}
          d="M26.89 4.48Q32 1.52 37.11 4.48L53.28 13.81Q58.39 16.76 58.39 22.67L58.39 41.33Q58.39 47.24 53.28 50.19L37.11 59.52Q32 62.48 26.89 59.52L10.72 50.19Q5.61 47.24 5.61 41.33L5.61 22.67Q5.61 16.76 10.72 13.81Z"
        />
      );
    case "triangle":
      return (
        <path
          fill={color}
          d="M26.93 8.02Q32 -1.76 37.07 8.02L59.41 51.09Q64.48 60.87 53.46 60.87L10.54 60.87Q-0.48 60.87 4.59 51.09Z"
        />
      );
    case "cloud":
      return (
        <g fill={color}>
          <circle cx="18" cy="39" r="18" />
          <circle cx="46" cy="39" r="18" />
          <circle cx="32" cy="41" r="17" />
          <circle cx="24" cy="23" r="15" />
          <circle cx="42" cy="21" r="16" />
        </g>
      );
    case "pill":
      return <rect x="3" y="12" width="58" height="40" rx="20" fill={color} />;
    case "diamond":
      return (
        <path
          fill={color}
          d="M26.38 5.81Q32 0.19 37.62 5.81L58.19 26.38Q63.81 32 58.19 37.62L37.62 58.19Q32 63.81 26.38 58.19L5.81 37.62Q0.19 32 5.81 26.38Z"
        />
      );
    case "pentagon":
      return (
        <path
          fill={color}
          d="M26.31 6.02Q32 1.89 37.69 6.02L56.89 19.97Q62.57 24.1 60.4 30.79L53.07 53.36Q50.9 60.04 43.86 60.04L20.14 60.04Q13.1 60.04 10.93 53.36L3.6 30.79Q1.43 24.1 7.11 19.97Z"
        />
      );
    case "star":
      return (
        <path
          fill={color}
          d="M30.61 6.05Q32 2.72 33.39 6.05L39.11 19.81Q40.5 23.15 44.1 23.44L58.96 24.63Q62.56 24.92 59.81 27.27L48.5 36.96Q45.75 39.32 46.59 42.83L50.05 57.33Q50.89 60.84 47.8 58.96L35.08 51.19Q32 49.31 28.92 51.19L16.2 58.96Q13.11 60.84 13.95 57.33L17.41 42.83Q18.25 39.32 15.5 36.96L4.19 27.27Q1.44 24.92 5.04 24.63L19.9 23.44Q23.5 23.15 24.89 19.81Z"
        />
      );
    case "heart":
      return (
        <path
          fill={color}
          d="M32 16C32 8.5 26.2 3.2 19.2 3.2C10.4 3.2 3.2 10.4 3.2 19.4C3.2 29.2 9.6 39.6 20.2 50.2C25.6 55.6 29.6 58.8 32 58.8C34.4 58.8 38.4 55.6 43.8 50.2C54.4 39.6 60.8 29.2 60.8 19.4C60.8 10.4 53.6 3.2 44.8 3.2C37.8 3.2 32 8.5 32 16Z"
        />
      );
  }
}

function Eyes({ cx, cy }: { cx: number; cy: number }) {
  const dx = 7.2;
  const w = 6;
  const h = 10.5;
  return (
    <g className="avatar-gaze" fill="#fff">
      <g className="avatar-blink">
        <rect
          className="avatar-eye"
          x={cx - dx - w / 2}
          y={cy - h / 2}
          width={w}
          height={h}
          rx={w / 2}
        />
        <rect
          className="avatar-eye"
          x={cx + dx - w / 2}
          y={cy - h / 2}
          width={w}
          height={h}
          rx={w / 2}
        />
      </g>
    </g>
  );
}

function liveMood(status?: AgentStatus | null): "idle" | "working" | "blocked" | null {
  if (status === "idle" || status === "working" || status === "blocked") {
    return status;
  }
  return null;
}

export function BotFace({ shape, color, className, title, status, id }: Props) {
  const eyes = eyesAt(shape);
  const live = liveMood(status);
  const cls = ["avatar-face", live ? `is-${live}` : "", className]
    .filter(Boolean)
    .join(" ");
  const style = live
    ? ({ ["--avatar-phase"]: avatarPhase(id) } as CSSProperties)
    : undefined;
  return (
    <svg
      className={cls}
      style={style}
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
