import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * The hoop a working bot's satellites ride. `rot` turns the plane (degrees), `k`
 * is how flat it looks (1 face on, small edge on) and `r` is how far it sits out
 * from the face, as a fraction of the face's reach.
 */
export type OrbitRoll = { rot: number; k: number; r: number };

/**
 * The hoop at rest, the way it is drawn before the first roll and without motion.
 * Keep it in step with the `--orbit-*` initial values in styles.css.
 */
export const ORBIT_REST: OrbitRoll = { rot: 0, k: 0.42, r: 0.15 };

const between = (rand: () => number, lo: number, hi: number) => lo + rand() * (hi - lo);

/** A new hoop. The ranges keep it a ring around the face, never edge on or far off. */
export function rollOrbit(rand: () => number = Math.random): OrbitRoll {
  return {
    rot: Math.round(between(rand, -85, 85)),
    k: +between(rand, 0.2, 0.72).toFixed(2),
    r: +between(rand, 0.11, 0.28).toFixed(2),
  };
}

/** How long a hoop is kept before the next roll. */
export function nextRollMs(rand: () => number = Math.random): number {
  return Math.round(between(rand, 2400, 4600));
}

type Target = { style: { setProperty(name: string, value: string): void } };
type Key = string | symbol;
type Shared = { roll: OrbitRoll; els: Set<Target>; timer: ReturnType<typeof setTimeout> | null };

// One hoop per bot, shared by every face of it, so the rail, the header and the chat
// show the same orbit at the same moment. It lives while a face of the bot works, and
// the CSS glides each face to the new roll.
const shared = new Map<Key, Shared>();

function write(el: Target, roll: OrbitRoll) {
  el.style.setProperty("--orbit-rot", `${roll.rot}deg`);
  el.style.setProperty("--orbit-k", String(roll.k));
  el.style.setProperty("--orbit-r", String(roll.r));
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** The next hoop, read against the motion preference each time so a change takes hold. */
function pick(rand: () => number): OrbitRoll {
  return reducedMotion() ? ORBIT_REST : rollOrbit(rand);
}

/**
 * A working face joins its bot's hoop. The first face of a bot rolls it and keeps
 * rolling it; the last one out stops. Returns the way out.
 */
export function attachOrbit(
  key: Key,
  el: Target,
  rand: () => number = Math.random,
): () => void {
  let s = shared.get(key);
  if (!s) {
    s = { roll: pick(rand), els: new Set(), timer: null };
    shared.set(key, s);
    const hold = s;
    const tick = () => {
      hold.roll = pick(rand);
      for (const e of hold.els) write(e, hold.roll);
      hold.timer = setTimeout(tick, nextRollMs(rand));
    };
    hold.timer = setTimeout(tick, nextRollMs(rand));
  }
  s.els.add(el);
  write(el, s.roll);
  const mine = s;
  return () => {
    mine.els.delete(el);
    if (mine.els.size > 0) return;
    if (mine.timer) clearTimeout(mine.timer);
    if (shared.get(key) === mine) shared.delete(key);
  };
}

/**
 * Gives the element a bot's shared hoop while `active`. A face without an id keeps
 * its own.
 */
export function useOrbitRoll(
  active: boolean,
  id: string | null | undefined,
  ref: RefObject<HTMLElement | null>,
): void {
  const own = useRef<symbol>(Symbol("orbit-roll"));
  const key: Key = id || own.current;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    // A face that joins starts on the hoop the others are on, not gliding to it from rest.
    el.style.transition = "none";
    const off = attachOrbit(key, el);
    void el.offsetWidth;
    el.style.removeProperty("transition");
    return () => {
      off();
      for (const name of ["--orbit-rot", "--orbit-k", "--orbit-r"]) el.style.removeProperty(name);
    };
  }, [active, key, ref]);
}
