import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { avatarPhase, type AvatarShape } from "../avatar";
import { EXTRA_BOXES, EXTRA_INKS, extraFace } from "../faceGeometry";
import type { AgentStatus } from "../types";

type Props = {
  shape: AvatarShape;
  color: string;
  className?: string;
  title?: string;
  status?: AgentStatus | null;
  id?: string | null;
  /** A held expression. It replaces what `status` would show and stops the eyes following. */
  mood?: FaceMood | null;
  /** Client point the idle face follows. Pointer aim wins while the cursor is on the face. */
  lookAt?: { x: number; y: number } | null;
};

function eyesAt(shape: AvatarShape): { x: number; y: number } {
  const extra = extraFace(shape);
  if (extra) return extra.eyes;
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
  const extra = extraFace(shape);
  if (extra) return <path fill={color} d={extra.d} />;
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
    default:
      return null;
  }
}

function Eye({ x, y, dir }: { x: number; y: number; dir: number }) {
  const w = 6;
  const h = 10.5;
  const ax = x + dir * 1.6;
  return (
    <g className="avatar-eye">
      <rect
        className="avatar-pill"
        x={x - w / 2}
        y={y - h / 2}
        width={w}
        height={h}
        rx={w / 2}
      />
      <path
        className="avatar-arc"
        d={`M${ax - 3} ${y + 1.8}Q${ax} ${y - 3.8} ${ax + 3} ${y + 1.8}`}
      />
    </g>
  );
}

function Eyes({ cx, cy }: { cx: number; cy: number }) {
  const dx = 7.2;
  return (
    <g className="avatar-gaze" fill="#fff">
      <g className="avatar-blink">
        <Eye x={cx - dx} y={cy} dir={-1} />
        <Eye x={cx + dx} y={cy} dir={1} />
      </g>
    </g>
  );
}

/** Expressions a caller can hold on a face, apart from the four statuses. */
export type FaceMood = "happy" | "success" | "failure" | "question";

/** A mark over the head's upper right. Its halo keeps it readable where it crosses the body. */
function QuestionMark({ color }: { color: string }) {
  const hook = "M-4.2 -5.2C-4.2 -9.4 4.2 -9.4 4.2 -4.8C4.2 -1.8 0 -1.6 0 2";
  return (
    <g className="avatar-mark" transform="translate(53 8) scale(1.25)">
      <g className="avatar-mark-pop">
        <g className="avatar-mark-halo" fill="none" stroke="var(--bg)" strokeWidth="6.4" strokeLinecap="round">
          <path d={hook} />
          <path d="M0 7.6V7.7" />
        </g>
        <g fill="none" stroke={color} strokeWidth="2.8" strokeLinecap="round">
          <path d={hook} />
          <path d="M0 7.6V7.7" />
        </g>
      </g>
    </g>
  );
}

/** Two Zs that float up from the head's upper right while the bot is down. */
function SleepMarks({ color }: { color: string }) {
  const z = "M-3.2 -3.4H3.2L-3.2 3.4H3.2";
  return (
    <g className="avatar-zzz" transform="translate(51 12)">
      {[0, 1].map((i) => (
        <g key={i} className="avatar-z">
          <g fill="none" stroke="var(--bg)" strokeWidth="5.6" strokeLinecap="round" strokeLinejoin="round">
            <path d={z} />
          </g>
          <g fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d={z} />
          </g>
        </g>
      ))}
    </g>
  );
}

type Mood = "idle" | "working" | "blocked" | "exited" | FaceMood;

function liveMood(status?: AgentStatus | null): Mood | null {
  if (
    status === "idle" ||
    status === "working" ||
    status === "blocked" ||
    status === "exited"
  ) {
    return status;
  }
  return null;
}

const HAPPY_MS = 1600;

function useHappy(status?: AgentStatus | null): boolean {
  const prev = useRef(status);
  const [happy, setHappy] = useState(false);
  useEffect(() => {
    const was = prev.current;
    prev.current = status;
    if (was !== "working" || status !== "idle") return;
    setHappy(true);
    const t = setTimeout(() => setHappy(false), HAPPY_MS);
    return () => clearTimeout(t);
  }, [status]);
  return happy;
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
  opticalX?: number;
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
  ...EXTRA_BOXES,
};

// Measured ink coverage of each shape's rendered alpha mask, not a hand fudge.
// min(area, width, height) match, so spiky shapes shrink toward the mean rather
// than inflating the way plain area matching would. Multiplies on top of SHAPE_BOX.
const SHAPE_INK: Record<AvatarShape, number> = {
  circle: 0.938,
  teardrop: 0.976,
  "rounded-square": 0.881,
  hexagon: 0.972,
  triangle: 0.942,
  cloud: 1.006,
  pill: 1.006,
  diamond: 0.993,
  pentagon: 0.983,
  star: 0.904,
  heart: 0.895,
  ...EXTRA_INKS,
};

// ponytail: scaling about the face centre is just a bigger `s`, since shapeFit
// already maps the shape's centre to (32,32) — no wrapper transform needed.
function shapeFit(shape: AvatarShape, ink = 1): string {
  const b = SHAPE_BOX[shape];
  const s = (FACE_SPAN / Math.max(b.w, b.h)) * (b.optical ?? 1) * ink;
  const cx = b.x + b.w / 2 + (b.opticalX ?? 0);
  const cy = b.y + b.h / 2 + (b.opticalY ?? 0);
  return `translate(32 32) scale(${s}) translate(${-cx} ${-cy})`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function gazeToward(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  eyes: { x: number; y: number },
): { x: number; y: number } {
  const x = ((clientX - rect.left) / Math.max(rect.width, 1)) * 64;
  const y = ((clientY - rect.top) / Math.max(rect.height, 1)) * 64;
  const nx = Math.max(-1, Math.min(1, (x - eyes.x) / 28));
  const ny = Math.max(-1, Math.min(1, (y - eyes.y) / 20));
  return { x: nx * GAZE_X, y: ny * GAZE_Y };
}

function gazeFromPointer(
  e: PointerEvent<SVGSVGElement>,
  eyes: { x: number; y: number },
): { x: number; y: number } {
  return gazeToward(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY, eyes);
}

// Leave eases home. A matching duration lives on `.is-gaze-return` in styles.css.
const GAZE_RETURN_MS = 320;
// The caret moves in jumps (a key, a click), so its gaze glides. The pointer
// stays transitionless so the eyes hit the same frame as the cursor.
const GAZE_CARET_EASE =
  "--gaze-x 0.22s cubic-bezier(0.22, 1, 0.36, 1), --gaze-y 0.22s cubic-bezier(0.22, 1, 0.36, 1)";

/** Where the eyes are drawn now, whether idle drift, a return, or a track. */
function currentGaze(svg: SVGSVGElement): { x: number; y: number } {
  const eyes = svg.querySelector(".avatar-gaze");
  if (!eyes) return { x: 0, y: 0 };
  const t = getComputedStyle(eyes).transform;
  if (!t || t === "none") return { x: 0, y: 0 };
  try {
    const m = new DOMMatrixReadOnly(t);
    return { x: m.m41, y: m.m42 };
  } catch {
    return { x: 0, y: 0 };
  }
}

function setGazeVar(svg: SVGSVGElement, name: string, value: string | null) {
  const current = svg.style.getPropertyValue(name);
  if (value === null) {
    if (current) svg.style.removeProperty(name);
    return;
  }
  if (current !== value) svg.style.setProperty(name, value);
}

function applyGaze(
  svg: SVGSVGElement | null,
  g: { x: number; y: number } | null,
  flags: { returning: boolean; settled: boolean; ease?: boolean },
) {
  if (!svg) return;
  // Tracking stays transitionless so the pointer still hits the same frame.
  // `is-gaze-return` is the only state that eases `--gaze-*` back to rest.
  svg.classList.toggle("is-tracking", !!g && !flags.returning);
  svg.classList.toggle("is-gaze-return", flags.returning);
  svg.classList.toggle("is-gaze-settled", flags.settled);
  if (flags.returning) svg.style.removeProperty("transition");
  else svg.style.transition = flags.ease ? GAZE_CARET_EASE : "none";
  if (g) {
    setGazeVar(svg, "--gaze-x", `${g.x}px`);
    setGazeVar(svg, "--gaze-y", `${g.y}px`);
  } else {
    setGazeVar(svg, "--gaze-x", null);
    setGazeVar(svg, "--gaze-y", null);
  }
}

type GazeMode = "idle" | "track" | "return";

export function BotFace({
  shape,
  color,
  className,
  title,
  status,
  id,
  mood = null,
  lookAt = null,
}: Props) {
  const eyes = eyesAt(shape);
  const happy = useHappy(status);
  const live: Mood | null = mood ?? (happy ? "happy" : liveMood(status));
  const svgRef = useRef<SVGSVGElement>(null);
  const gazeRef = useRef<{ x: number; y: number } | null>(null);
  const settledRef = useRef(false);
  const pointerRef = useRef(false);
  const lookRef = useRef(lookAt);
  lookRef.current = lookAt;
  const [mode, setMode] = useState<GazeMode>("idle");
  const modeRef = useRef<GazeMode>("idle");
  modeRef.current = mode;

  function followCaret(svg: SVGSVGElement, point: { x: number; y: number }) {
    const g = gazeToward(svg.getBoundingClientRect(), point.x, point.y, eyes);
    if (modeRef.current !== "track") {
      // Tracking replaces the idle drift, which would snap the eyes to the
      // target. Start from where they are drawn, paint that once, then glide.
      const from = currentGaze(svg);
      applyGaze(svg, from, { returning: false, settled: settledRef.current });
      svg.getBoundingClientRect();
      modeRef.current = "track";
      setMode("track");
    }
    gazeRef.current = g;
    applyGaze(svg, g, { returning: false, settled: settledRef.current, ease: true });
  }

  function releaseCaret(svg: SVGSVGElement) {
    const g = gazeRef.current;
    const nearHome = !g || (Math.abs(g.x) < 0.05 && Math.abs(g.y) < 0.05);
    if (prefersReducedMotion() || nearHome) {
      gazeRef.current = null;
      settledRef.current = true;
      applyGaze(svg, null, { returning: false, settled: true });
      if (modeRef.current !== "idle") {
        modeRef.current = "idle";
        setMode("idle");
      }
      return;
    }
    if (modeRef.current !== "return") {
      modeRef.current = "return";
      setMode("return");
    }
  }

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    if (live) svg.style.setProperty("--avatar-phase", String(avatarPhase(id)));
    else svg.style.removeProperty("--avatar-phase");
    const follow =
      !pointerRef.current &&
      !!lookAt &&
      !mood &&
      status === "idle" &&
      !prefersReducedMotion();
    if (follow) {
      followCaret(svg, lookAt);
      return;
    }
    if (!pointerRef.current && modeRef.current === "track") {
      releaseCaret(svg);
      return;
    }
    applyGaze(svg, gazeRef.current, {
      returning: mode === "return",
      settled: settledRef.current,
    });
  });

  useEffect(() => {
    if (!lookAt || status !== "idle") return;
    const refresh = () => {
      const svg = svgRef.current;
      const point = lookRef.current;
      if (!svg || !point || pointerRef.current || prefersReducedMotion()) return;
      const g = gazeToward(
        svg.getBoundingClientRect(),
        point.x,
        point.y,
        eyesAt(shape),
      );
      gazeRef.current = g;
      applyGaze(svg, g, { returning: false, settled: settledRef.current });
    };
    window.addEventListener("scroll", refresh, true);
    window.addEventListener("resize", refresh);
    return () => {
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
    };
  }, [lookAt, status, shape]);

  useEffect(() => {
    if (mode !== "return") return;
    const svg = svgRef.current;
    if (!svg) return;
    let finished = false;
    let raf2 = 0;
    let timer = 0;
    const finish = () => {
      if (finished || modeRef.current !== "return") return;
      finished = true;
      gazeRef.current = null;
      settledRef.current = true;
      applyGaze(svg, null, { returning: false, settled: true });
      modeRef.current = "idle";
      setMode("idle");
    };
    const onEnd = (ev: Event) => {
      const e = ev as TransitionEvent;
      if (e.target !== svg) return;
      if (e.propertyName !== "--gaze-x" && e.propertyName !== "--gaze-y") return;
      finish();
    };
    // The offset has to be painted with the return transition armed before
    // the target moves to rest, or the eyes skip straight home.
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (finished || modeRef.current !== "return" || !svg.isConnected) return;
        gazeRef.current = { x: 0, y: 0 };
        applyGaze(svg, gazeRef.current, {
          returning: true,
          settled: settledRef.current,
        });
        svg.addEventListener("transitionend", onEnd);
        timer = window.setTimeout(finish, GAZE_RETURN_MS + 160);
      });
    });
    return () => {
      finished = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(timer);
      svg.removeEventListener("transitionend", onEnd);
    };
  }, [mode]);

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    if (prefersReducedMotion()) return;
    pointerRef.current = true;
    const g = gazeFromPointer(e, eyes);
    gazeRef.current = g;
    applyGaze(e.currentTarget, g, {
      returning: false,
      settled: settledRef.current,
    });
    // Written on this turn so a return frame already queued cannot treat the
    // pointer as still gone. A leave may have queued "return" while the last
    // commit was still "track"; skipping setMode would keep that queue.
    const prev = modeRef.current;
    modeRef.current = "track";
    if (prev !== "track" || mode !== "track") setMode("track");
  }

  function onPointerLeave(e: PointerEvent<SVGSVGElement>) {
    pointerRef.current = false;
    const point = lookRef.current;
    if (point && status === "idle" && !prefersReducedMotion()) {
      followCaret(e.currentTarget, point);
      return;
    }
    const g = gazeRef.current;
    if (!g) return;
    const nearHome = Math.abs(g.x) < 0.05 && Math.abs(g.y) < 0.05;
    if (prefersReducedMotion() || nearHome) {
      gazeRef.current = null;
      settledRef.current = true;
      applyGaze(e.currentTarget, null, { returning: false, settled: true });
      modeRef.current = "idle";
      setMode("idle");
      return;
    }
    modeRef.current = "return";
    setMode("return");
  }

  const cls = [
    "avatar-face",
    live ? `is-${live}` : "",
    mode === "track" ? "is-tracking" : "",
    mode === "return" ? "is-gaze-return" : "",
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
      <g transform={shapeFit(shape, SHAPE_INK[shape])}>
        <Shape shape={shape} color={color} />
      </g>
      <g transform={shapeFit(shape)}>
        <Eyes cx={eyes.x} cy={eyes.y} />
      </g>
      {live === "question" ? <QuestionMark color={color} /> : null}
      {live === "exited" ? <SleepMarks color={color} /> : null}
    </svg>
  );
}
