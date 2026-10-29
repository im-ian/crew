import { describe, expect, it } from "vitest";
import { WORK_LOOKS, claimWorkLook, pickWorkLook, releaseWorkLook } from "./workLook";

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

describe("claimWorkLook", () => {
  it("gives every face of one bot the same look during a run", () => {
    releaseWorkLook("bot-a");
    const first = claimWorkLook("bot-a", () => 0.1);
    expect(claimWorkLook("bot-a", () => 0.9)).toBe(first);
    expect(claimWorkLook("bot-a")).toBe(first);
  });

  it("draws again after the run ends, and not the same look", () => {
    releaseWorkLook("bot-b");
    let prev = claimWorkLook("bot-b", () => 0.3);
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      releaseWorkLook("bot-b");
      const next = claimWorkLook("bot-b", () => r);
      expect(next).not.toBe(prev);
      prev = next;
    }
  });

  it("keeps bots apart", () => {
    releaseWorkLook("bot-c");
    releaseWorkLook("bot-d");
    const c = claimWorkLook("bot-c", () => 0);
    const d = claimWorkLook("bot-d", () => 0.99);
    expect(c).not.toBe(d);
    expect(claimWorkLook("bot-c")).toBe(c);
  });
});
