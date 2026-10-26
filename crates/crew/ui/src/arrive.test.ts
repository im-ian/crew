import { describe, expect, it } from "vitest";
import { arriveStart, arrivingIds } from "./arrive";

describe("arrivingIds", () => {
  it("lets a message land in an empty chat", () => {
    expect(arrivingIds([], ["m"])).toEqual(["m"]);
    expect(arrivingIds([], ["m", "n"])).toEqual(["m", "n"]);
  });

  it("stays still for a history load", () => {
    expect(arrivingIds([], ["a", "b", "c"])).toEqual([]);
    expect(arrivingIds([], [])).toEqual([]);
  });

  it("moves only the rows that were not already on screen", () => {
    expect(arrivingIds(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
    expect(arrivingIds(["a"], ["a", "b", "c"])).toEqual(["b", "c"]);
    expect(arrivingIds(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("stays still when the thread is replaced", () => {
    expect(arrivingIds(["a", "b"], ["c"])).toEqual([]);
    expect(arrivingIds(["a", "b", "c"], ["d", "e", "f"])).toEqual([]);
    expect(arrivingIds(["a", "b"], [])).toEqual([]);
  });

  it("keeps a row written before the chat opened still", () => {
    const old = new Set(["t1", "h0"]);
    const isNew = (id: string) => !old.has(id);
    // Tool cards shown again, or older history, sit among rows already there.
    expect(arrivingIds(["a", "b"], ["a", "t1", "b"], isNew)).toEqual([]);
    expect(arrivingIds(["a", "b"], ["h0", "a", "b"], isNew)).toEqual([]);
    // A chat whose two rows load a moment after it opens.
    expect(arrivingIds([], ["t1", "h0"], isNew)).toEqual([]);
    // What is written now still moves, and the typing row is never old.
    expect(arrivingIds(["a"], ["a", "t1", "c"], isNew)).toEqual(["c"]);
    expect(arrivingIds(["a"], ["a", "working-jordy"], () => false)).toEqual([
      "working-jordy",
    ]);
  });

  it("brings in the typing row, and the reply that takes its place", () => {
    expect(arrivingIds(["a"], ["a", "working-jordy"])).toEqual(["working-jordy"]);
    expect(arrivingIds(["working-jordy"], ["m"])).toEqual(["m"]);
    expect(arrivingIds(["a", "working-jordy"], ["a", "m"])).toEqual(["m"]);
  });
});

describe("arriveStart", () => {
  it("grows a new row from nothing", () => {
    expect(arriveStart(["a"], ["a", "b"], "b", 40)).toBe(0);
    expect(arriveStart(["a"], ["a", "working-jordy"], "working-jordy", 40)).toBe(0);
    expect(arriveStart([], ["m"], "m", 40)).toBe(0);
    expect(arriveStart(["a"], ["a", "b"], "a", 40)).toBeNull();
  });

  it("starts the reply at the typing row it replaces", () => {
    expect(arriveStart(["a", "working-jordy"], ["a", "m"], "m", 48)).toBe(48);
    expect(arriveStart(["working-jordy"], ["m"], "m", 48)).toBe(48);
  });

  it("leaves an old row out", () => {
    expect(arriveStart(["a"], ["a", "b"], "b", 40, () => false)).toBeNull();
  });

  it("does not borrow a typing height when the thread is replaced", () => {
    expect(arriveStart(["a", "working-jordy"], ["x", "y", "z"], "x", 48)).toBeNull();
  });

  it("gives only the row that takes the typing place that height", () => {
    expect(arriveStart(["working-jordy"], ["m", "n"], "m", 48)).toBe(48);
    expect(arriveStart(["working-jordy"], ["m", "n"], "n", 48)).toBe(0);
  });
});
