import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
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
      return <rect x="2" y="9" width="60" height="46" rx="23" fill={color} />;
    case "diamond":
      return (
        <path
          fill={color}
          d="M25.42 6.77Q32 0.19 38.58 6.77L57.23 25.42Q63.81 32 57.23 38.58L38.58 57.23Q32 63.81 25.42 57.23L6.77 38.58Q0.19 32 6.77 25.42Z"
        />
      );
    case "pentagon":
      return (
        <path
          fill={color}
          d="M25.37 6.71Q32 1.89 38.63 6.71L55.94 19.28Q62.57 24.1 60.04 31.9L53.43 52.24Q50.9 60.04 42.7 60.04L21.3 60.04Q13.1 60.04 10.57 52.24L3.96 31.9Q1.43 24.1 8.06 19.28Z"
        />
      );
    case "star":
      return (
        <path
          fill={color}
          d="M30.08 7.34Q32 2.72 33.92 7.34L38.58 18.53Q40.5 23.15 45.48 23.55L57.58 24.52Q62.56 24.92 58.76 28.17L49.55 36.07Q45.75 39.32 46.91 44.18L49.73 55.98Q50.89 60.84 46.62 58.24L36.27 51.91Q32 49.31 27.73 51.91L17.38 58.24Q13.11 60.84 14.27 55.98L17.09 44.18Q18.25 39.32 14.45 36.07L5.24 28.17Q1.44 24.92 6.42 24.52L18.52 23.55Q23.5 23.15 25.42 18.53Z"
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

const GAZE_X = 4.6;
const GAZE_Y = 3.2;
const FACE_SPAN = 60;

type ShapeBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  optical?: number;
  opticalY?: number;
};

const SHAPE_BOX: Record<AvatarShape, ShapeBox> = {
  circle: { x: 2, y: 2, w: 60, h: 60 },
  teardrop: { x: 8, y: 6, w: 48, h: 51 },
  "rounded-square": { x: 3, y: 3, w: 58, h: 58 },
  hexagon: { x: 5.61, y: 3, w: 52.78, h: 58 },
  triangle: { x: 2.99, y: 3.13, w: 58.02, h: 57.74, optical: 1.04, opticalY: 3.4 },
  cloud: { x: 0, y: 5, w: 64, h: 53, opticalY: 1.6 },
  pill: { x: 2, y: 9, w: 60, h: 46 },
  diamond: { x: 3, y: 3, w: 58, h: 58 },
  pentagon: { x: 3, y: 3.96, w: 58, h: 56.08, opticalY: 2 },
  star: { x: 3, y: 4.39, w: 58, h: 55.23, optical: 1.14, opticalY: 2.8 },
  heart: { x: 3.2, y: 3.2, w: 57.6, h: 55.6, optical: 1.12, opticalY: 1.4 },
};

function shapeFit(shape: AvatarShape): string {
  const b = SHAPE_BOX[shape];
  const s = (FACE_SPAN / Math.max(b.w, b.h)) * (b.optical ?? 1);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2 + (b.opticalY ?? 0);
  return `translate(32 32) scale(${s}) translate(${-cx} ${-cy})`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function gazeFromPointer(
  e: PointerEvent<SVGSVGElement>,
  eyes: { x: number; y: number },
): { x: number; y: number } {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 64;
  const y = ((e.clientY - rect.top) / Math.max(rect.height, 1)) * 64;
  const nx = Math.max(-1, Math.min(1, (x - eyes.x) / 28));
  const ny = Math.max(-1, Math.min(1, (y - eyes.y) / 20));
  return { x: nx * GAZE_X, y: ny * GAZE_Y };
}

function applyGaze(
  svg: SVGSVGElement | null,
  g: { x: number; y: number } | null,
) {
  if (!svg) return;
  if (g) {
    svg.style.setProperty("--gaze-x", `${g.x}px`);
    svg.style.setProperty("--gaze-y", `${g.y}px`);
    svg.classList.add("is-tracking");
  } else {
    svg.style.removeProperty("--gaze-x");
    svg.style.removeProperty("--gaze-y");
    svg.classList.remove("is-tracking");
  }
}

export function BotFace({ shape, color, className, title, status, id }: Props) {
  const eyes = eyesAt(shape);
  const live = liveMood(status);
  const svgRef = useRef<SVGSVGElement>(null);
  const gazeRef = useRef<{ x: number; y: number } | null>(null);
  const [tracking, setTracking] = useState(false);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    if (live) svg.style.setProperty("--avatar-phase", String(avatarPhase(id)));
    else svg.style.removeProperty("--avatar-phase");
    applyGaze(svg, gazeRef.current);
  });

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    if (prefersReducedMotion()) return;
    const g = gazeFromPointer(e, eyes);
    gazeRef.current = g;
    applyGaze(e.currentTarget, g);
    setTracking(true);
  }

  function onPointerLeave(e: PointerEvent<SVGSVGElement>) {
    gazeRef.current = null;
    applyGaze(e.currentTarget, null);
    setTracking(false);
  }

  const cls = [
    "avatar-face",
    live ? `is-${live}` : "",
    tracking ? "is-tracking" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      ref={svgRef}
      className={cls}
      viewBox="0 0 64 64"
      width="100%"
      height="100%"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      overflow="visible"
      onPointerEnter={onPointerMove}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {title ? <title>{title}</title> : null}
      <g transform={shapeFit(shape)}>
        <Shape shape={shape} color={color} />
        <Eyes cx={eyes.x} cy={eyes.y} />
      </g>
    </svg>
  );
}
