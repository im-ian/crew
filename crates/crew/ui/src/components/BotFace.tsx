import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { SHAPES, type ShapeDef } from "crew-avatar";
import { avatarPhase, type AvatarShape } from "../avatar";
import { afterglowAt, type BotSignal } from "../botSignals";
import type { AgentStatus } from "../types";
import type { WorkLook } from "../workLook";

type Props = {
  shape: AvatarShape;
  color: string;
  className?: string;
  title?: string;
  status?: AgentStatus | null;
  id?: string | null;
  /** A held expression. It replaces what `status` would show and stops the eyes following. */
  mood?: FaceMood | null;
  /** How the face works while `status` is working. The props live in WorkProps. */
  look?: WorkLook | null;
  /** What the bot's list entry says beyond its status: a failed turn, an open question. */
  signal?: BotSignal | null;
  /** Client point the idle face follows. Pointer aim wins while the cursor is on the face. */
  lookAt?: { x: number; y: number } | null;
  /**
   * Resting while bots it asked work on its request: it taps and glances
   * aside instead of looking around, and does not follow the caret.
   */
  waiting?: boolean;
};

// The outline, size and eyes of every shape come from crew-avatar.
function defOf(shape: AvatarShape): ShapeDef {
  return SHAPES[shape];
}

function eyesAt(shape: AvatarShape): { x: number; y: number; dx?: number } {
  return defOf(shape).eyes;
}

function Shape({ shape, color }: { shape: AvatarShape; color: string }) {
  // Static markup painted through `currentColor`.
  return <g color={color} dangerouslySetInnerHTML={{ __html: defOf(shape).markup }} />;
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

function Eyes({ cx, cy, dx = 7.2 }: { cx: number; cy: number; dx?: number }) {
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
/** `calm` is the dance settled: the success eyes, standing still. */
export type FaceMood = "happy" | "calm" | "success" | "failure" | "question";

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

type Mood = "idle" | "working" | "blocked" | "exited" | "waiting" | FaceMood;

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

/**
 * The face a bot wears when a run ends: a smile for a quick one, a dance for a
 * long one, a droop for one that failed. It goes as soon as the bot starts
 * something else. When the run ended with its chat unseen the reaction keeps
 * going until the reader looks, except the dance: it plays a few times, then
 * settles into a still smile. A run that ends with the reader already in the
 * chat plays for its usual moment.
 */
function useAfterglow(
  status: AgentStatus | null | undefined,
  signal: BotSignal | null | undefined,
): "happy" | "calm" | "success" | "failure" | null {
  const [, wake] = useState(0);
  const endedAt = signal?.endedAt ?? 0;
  const glow = afterglowAt(status, signal, Date.now());
  // Also while held: a dance has to stop when its moment ends.
  const waiting = !!glow && glow.left > 0;
  const left = glow?.left ?? 0;
  const kind = glow?.kind;
  // The kind moves the moment's length (a failure outlasts the rest), so it re-arms.
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => wake((n) => n + 1), left + 1);
    return () => clearTimeout(t);
  }, [waiting, endedAt, kind, left]);
  return glow?.shown ? glow.kind : null;
}

const GAZE_X = 4.6;
const GAZE_Y = 3.2;
const FACE_SPAN = 60;

// ponytail: scaling about the face centre is just a bigger `s`, since shapeFit
// already maps the shape's centre to (32,32) — no wrapper transform needed.
// `ink` is the measured ink coverage of the shape's rendered alpha mask. It
// shrinks spiky shapes toward the mean instead of inflating them the way plain
// area matching would, and multiplies on top of the box fit.
function shapeFit(shape: AvatarShape, ink = 1): string {
  const b = defOf(shape).box;
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
  look = null,
  signal = null,
  lookAt = null,
  waiting = false,
}: Props) {
  const eyes = eyesAt(shape);
  const glow = useAfterglow(status, signal);
  const asking = !!signal?.asking && status !== "exited";
  const resting = liveMood(status);
  const live: Mood | null =
    mood ?? (asking ? "question" : (glow ?? (waiting && resting === "idle" ? "waiting" : resting)));
  // A held face has its own eyes, so the caret does not steer them.
  const held =
    !!mood ||
    asking ||
    glow === "success" ||
    glow === "calm" ||
    glow === "failure" ||
    live === "waiting";
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
      !held &&
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
    if (!lookAt || status !== "idle" || held) return;
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
  }, [lookAt, status, shape, held]);

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
    if (point && status === "idle" && !held && !prefersReducedMotion()) {
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
    live === "working" && look ? `look-${look}` : "",
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
      <g transform={shapeFit(shape, defOf(shape).ink)}>
        <Shape shape={shape} color={color} />
      </g>
      <g transform={shapeFit(shape)}>
        <Eyes cx={eyes.x} cy={eyes.y} dx={eyes.dx} />
      </g>
      {live === "question" ? <QuestionMark color={color} /> : null}
      {live === "exited" ? <SleepMarks color={color} /> : null}
    </svg>
  );
}
