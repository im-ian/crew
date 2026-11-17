import { describe, expect, it } from "vitest";
import { chipCount, chipRhythm, initialChips, liveIds, nextChips, settleChips } from "./waitChips";

const width = (id: string) => ({ a: 80, b: 64, c: 72 })[id];

describe("waiting chips", () => {
  it("draws the first line at once, in the order asked", () => {
    expect(initialChips(["a", "b"])).toEqual([
      { id: "a", entering: false, leaving: false },
      { id: "b", entering: false, leaving: false },
    ]);
  });

  it("folds out a chip whose bot answered, from where it stood and its width", () => {
    const next = nextChips(initialChips(["a", "b", "c"]), ["a", "c"], false, width);
    expect(next.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(next[1]).toEqual({ id: "b", entering: false, leaving: true, width: 64 });
    expect(chipCount(next)).toBe(2);
    expect(settleChips(next).map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("grows a new one in at the end", () => {
    const next = nextChips(initialChips(["a"]), ["a", "b"], false, width);
    expect(next[1]).toEqual({ id: "b", entering: true, leaving: false });
  });

  it("keeps a chip whose bot is waited on again before it is gone", () => {
    const going = nextChips(initialChips(["a", "b"]), ["a"], false, width);
    const back = nextChips(going, ["a", "b"], false, width);
    expect(back.map((c) => [c.id, c.leaving])).toEqual([["a", false], ["b", false]]);
  });

  it("keeps the width it had when a leaving chip is passed again", () => {
    const going = nextChips(initialChips(["a", "b"]), ["a"], false, width);
    const again = nextChips(going, ["a"], false, () => 0);
    expect(again[1].width).toBe(64);
  });

  it("the last one leaving empties the count; the line then goes", () => {
    const going = nextChips(initialChips(["a"]), [], false, width);
    expect(chipCount(going)).toBe(0);
    expect(settleChips(going)).toEqual([]);
  });

  it("with reduced motion, drops and adds at once", () => {
    const next = nextChips(initialChips(["a", "b"]), ["b", "c"], true, width);
    expect(next).toEqual([
      { id: "b", entering: false, leaving: false },
      { id: "c", entering: false, leaving: false },
    ]);
  });
});

describe("chip rhythm", () => {
  it("breathes every 1.8s up to three bots, slower from four", () => {
    expect(chipRhythm(1).cycle).toBe(1.8);
    expect(chipRhythm(3).cycle).toBe(1.8);
    expect(chipRhythm(4).cycle).toBe(3.2);
  });

  it("passes left to right, 12% of a cycle apart, at most 0.6s", () => {
    const { delay } = chipRhythm(3);
    expect([0, 1, 2].map(delay)).toEqual([0, 0.22, 0.43]);
    expect(chipRhythm(6).delay(5)).toBe(0.6);
  });

  it("counts only the chips that are staying", () => {
    const going = nextChips(initialChips(["a", "b", "c"]), ["b", "c"], false, () => 15);
    expect(liveIds(going)).toEqual(["b", "c"]);
  });
});
