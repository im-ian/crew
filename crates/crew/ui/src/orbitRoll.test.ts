import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORBIT_REST, attachOrbit, nextRollMs, rollOrbit } from "./orbitRoll";

function el() {
  const props = new Map<string, string>();
  return {
    props,
    style: { setProperty: (n: string, v: string) => void props.set(n, v) },
  };
}

/** A random source that walks a fixed list, so every roll is known. */
function seq(...xs: number[]) {
  let i = 0;
  return () => xs[i++ % xs.length];
}

describe("rollOrbit", () => {
  it("stays a ring around the face at both ends of the random source", () => {
    for (const r of [0, 0.5, 0.999999]) {
      const o = rollOrbit(() => r);
      expect(o.rot).toBeGreaterThanOrEqual(-85);
      expect(o.rot).toBeLessThanOrEqual(85);
      expect(o.k).toBeGreaterThanOrEqual(0.2);
      expect(o.k).toBeLessThanOrEqual(0.72);
      expect(o.r).toBeGreaterThanOrEqual(0.11);
      expect(o.r).toBeLessThanOrEqual(0.28);
    }
  });

  it("rests as the plain tilted hoop", () => {
    expect(ORBIT_REST).toEqual({ rot: 0, k: 0.42, r: 0.15 });
  });
});

describe("nextRollMs", () => {
  it("keeps a hoop for a few seconds", () => {
    expect(nextRollMs(() => 0)).toBe(2400);
    expect(nextRollMs(() => 1)).toBe(4600);
  });
});

describe("attachOrbit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hands the face a hoop at once and a new one every few seconds", () => {
    const a = el();
    const off = attachOrbit("bot-a", a, seq(0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0));
    expect(a.props.get("--orbit-rot")).toBe("0deg");
    expect(a.props.get("--orbit-k")).toBe("0.46");
    vi.advanceTimersByTime(5000);
    expect(a.props.get("--orbit-rot")).toBe("-85deg");
    off();
  });

  it("gives every face of a bot the same hoop", () => {
    const a = el();
    const b = el();
    const offA = attachOrbit("bot-b", a);
    const offB = attachOrbit("bot-b", b);
    expect(b.props.get("--orbit-rot")).toBe(a.props.get("--orbit-rot"));
    vi.advanceTimersByTime(5000);
    expect(b.props.get("--orbit-k")).toBe(a.props.get("--orbit-k"));
    expect(b.props.get("--orbit-r")).toBe(a.props.get("--orbit-r"));
    offA();
    offB();
  });

  it("keeps rolling while one face is left, and stops when the last goes", () => {
    const a = el();
    const b = el();
    const offA = attachOrbit("bot-c", a);
    const offB = attachOrbit("bot-c", b);
    offA();
    expect(vi.getTimerCount()).toBe(1);
    offB();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not write to a face that left", () => {
    const a = el();
    const off = attachOrbit("bot-d", a, seq(0.5, 0.2, 0.9, 0.9, 0.9, 0.9));
    off();
    a.props.clear();
    vi.advanceTimersByTime(10_000);
    expect(a.props.size).toBe(0);
  });

  it("starts a fresh hoop for a bot that works again", () => {
    const a = el();
    const first = attachOrbit("bot-e", a, seq(0.1, 0.1, 0.1));
    first();
    const b = el();
    const second = attachOrbit("bot-e", b, seq(0.9, 0.9, 0.9));
    expect(b.props.get("--orbit-rot")).not.toBe(a.props.get("--orbit-rot"));
    second();
  });

  it("keeps different bots apart", () => {
    const a = el();
    const b = el();
    const offA = attachOrbit("bot-f", a, seq(0.1, 0.1, 0.1, 0.1, 0.1, 0.1));
    const offB = attachOrbit("bot-g", b, seq(0.9, 0.9, 0.9, 0.9, 0.9, 0.9));
    expect(a.props.get("--orbit-rot")).not.toBe(b.props.get("--orbit-rot"));
    offA();
    offB();
  });
});
