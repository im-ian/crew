import { describe, expect, it } from "vitest";
import { arrivingIds } from "./arrive";

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

  it("brings in the typing row, and the reply that takes its place", () => {
    expect(arrivingIds(["a"], ["a", "working-jordy"])).toEqual(["working-jordy"]);
    expect(arrivingIds(["working-jordy"], ["m"])).toEqual(["m"]);
    expect(arrivingIds(["a", "working-jordy"], ["a", "m"])).toEqual(["m"]);
  });
});
