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
  // Every face is let go after its test, so a failed assertion cannot leave a bot
  // and its timer registered for the next one.
  const live: (() => void)[] = [];
  const join = (key: string, e: ReturnType<typeof el>, rand?: () => number) => {
    const off = attachOrbit(key, e, rand);
    live.push(off);
    return off;
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    live.splice(0).forEach((off) => off());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("hands the face a hoop at once and a new one every few seconds", () => {
    const a = el();
    join("bot-a", a, seq(0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0));
    expect(a.props.get("--orbit-rot")).toBe("0deg");
    expect(a.props.get("--orbit-k")).toBe("0.46");
    vi.advanceTimersByTime(5000);
    expect(a.props.get("--orbit-rot")).toBe("-85deg");
  });

  it("gives every face of a bot the same hoop", () => {
    const a = el();
    const b = el();
    join("bot-b", a);
    join("bot-b", b);
    expect(b.props.get("--orbit-rot")).toBe(a.props.get("--orbit-rot"));
    vi.advanceTimersByTime(5000);
    expect(b.props.get("--orbit-k")).toBe(a.props.get("--orbit-k"));
    expect(b.props.get("--orbit-r")).toBe(a.props.get("--orbit-r"));
  });

  it("keeps rolling while one face is left, and stops when the last goes", () => {
    const offA = join("bot-c", el());
    const offB = join("bot-c", el());
    offA();
    expect(vi.getTimerCount()).toBe(1);
    offB();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not write to a face that left", () => {
    const a = el();
    const off = join("bot-d", a, seq(0.5, 0.2, 0.9, 0.9, 0.9, 0.9));
    off();
    a.props.clear();
    vi.advanceTimersByTime(10_000);
    expect(a.props.size).toBe(0);
  });

  it("starts a fresh hoop for a bot that works again", () => {
    const a = el();
    join("bot-e", a, seq(0.1, 0.1, 0.1))();
    const b = el();
    join("bot-e", b, seq(0.9, 0.9, 0.9));
    expect(b.props.get("--orbit-rot")).not.toBe(a.props.get("--orbit-rot"));
  });

  it("keeps different bots apart", () => {
    const a = el();
    const b = el();
    join("bot-f", a, seq(0.1, 0.1, 0.1, 0.1, 0.1, 0.1));
    join("bot-g", b, seq(0.9, 0.9, 0.9, 0.9, 0.9, 0.9));
    expect(a.props.get("--orbit-rot")).not.toBe(b.props.get("--orbit-rot"));
  });

  it("holds the plain hoop under reduced motion", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const a = el();
    join("bot-h", a);
    expect(a.props.get("--orbit-rot")).toBe("0deg");
    expect(a.props.get("--orbit-k")).toBe("0.42");
    expect(a.props.get("--orbit-r")).toBe("0.15");
    vi.advanceTimersByTime(20_000);
    expect(a.props.get("--orbit-rot")).toBe("0deg");
    expect(a.props.get("--orbit-k")).toBe("0.42");
  });

  it("follows a change of the motion preference while the bot works", () => {
    let reduced = false;
    vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
    const a = el();
    join("bot-i", a, seq(0.9, 0.9, 0.9));
    expect(a.props.get("--orbit-rot")).not.toBe("0deg");
    reduced = true;
    vi.advanceTimersByTime(5000);
    expect(a.props.get("--orbit-rot")).toBe("0deg");
    expect(a.props.get("--orbit-k")).toBe("0.42");
    reduced = false;
    vi.advanceTimersByTime(5000);
    expect(a.props.get("--orbit-rot")).not.toBe("0deg");
  });
});
