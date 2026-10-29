import { describe, expect, it } from "vitest";
import { WORK_LOOKS, acquireWorkLook, pickWorkLook, releaseWorkLook } from "./workLook";

describe("pickWorkLook", () => {
  it("draws from every look when nothing was used before", () => {
    const seen = new Set<string>();
    for (let i = 0; i < WORK_LOOKS.length; i++) {
      seen.add(pickWorkLook(null, () => i / WORK_LOOKS.length));
    }
    expect([...seen].sort()).toEqual([...WORK_LOOKS].sort());
  });

  it("never repeats the previous look", () => {
    for (const prev of WORK_LOOKS) {
      for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.999999]) {
        expect(pickWorkLook(prev, () => r)).not.toBe(prev);
      }
    }
  });

  it("still reaches every other look after one was used", () => {
    const seen = new Set<string>();
    for (const r of [0, 0.3, 0.55, 0.8]) seen.add(pickWorkLook("hustle", () => r));
    expect(seen.size).toBe(WORK_LOOKS.length - 1);
  });

  it("stays in range when the random source returns 1", () => {
    expect(WORK_LOOKS).toContain(pickWorkLook(null, () => 1));
    expect(WORK_LOOKS).toContain(pickWorkLook("laptop", () => 1));
  });
});

describe("acquireWorkLook", () => {
  it("gives every working face of one bot the same look", () => {
    const first = acquireWorkLook("bot-a", () => 0.1);
    expect(acquireWorkLook("bot-a", () => 0.9)).toBe(first);
    releaseWorkLook("bot-a");
    releaseWorkLook("bot-a");
  });

  it("keeps the run while one face is still working", () => {
    const first = acquireWorkLook("bot-b", () => 0.1);
    acquireWorkLook("bot-b", () => 0.9);
    releaseWorkLook("bot-b");
    expect(acquireWorkLook("bot-b", () => 0.9)).toBe(first);
    releaseWorkLook("bot-b");
    releaseWorkLook("bot-b");
  });

  it("draws again once the last face is gone, and not the same look", () => {
    let prev = acquireWorkLook("bot-c", () => 0.3);
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      releaseWorkLook("bot-c");
      const next = acquireWorkLook("bot-c", () => r);
      expect(next).not.toBe(prev);
      prev = next;
    }
    releaseWorkLook("bot-c");
  });

  it("keeps bots apart", () => {
    const c = acquireWorkLook("bot-d", () => 0);
    const d = acquireWorkLook("bot-e", () => 0.99);
    expect(c).not.toBe(d);
    expect(acquireWorkLook("bot-d")).toBe(c);
    releaseWorkLook("bot-d");
    releaseWorkLook("bot-d");
    releaseWorkLook("bot-e");
  });

  it("ignores a release that has no matching acquire", () => {
    releaseWorkLook("bot-never");
    expect(WORK_LOOKS).toContain(acquireWorkLook("bot-never", () => 0.4));
    releaseWorkLook("bot-never");
  });
});
