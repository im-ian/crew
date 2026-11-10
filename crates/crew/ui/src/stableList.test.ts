import { describe, expect, it } from "vitest";
import { keepSame, sameValue } from "./stableList";

describe("sameValue", () => {
  it("compares nested JSON-like values", () => {
    expect(sameValue({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true);
    expect(sameValue({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue([1], { 0: 1 })).toBe(false);
    expect(sameValue(null, {})).toBe(false);
  });
});

describe("keepSame", () => {
  it("hands back the old list when nothing changed", () => {
    const prev = [{ id: "a", text: "hi" }, { id: "b", text: "yo" }];
    const next = [{ id: "a", text: "hi" }, { id: "b", text: "yo" }];
    expect(keepSame(prev, next)).toBe(prev);
  });

  it("keeps unchanged rows and takes the changed one", () => {
    const prev = [{ id: "a", text: "hi" }, { id: "b", text: "yo" }];
    const next = [{ id: "a", text: "hi" }, { id: "b", text: "yo!" }];
    const out = keepSame(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
  });

  it("matches rows by id when one is taken out of the middle", () => {
    const prev = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const out = keepSame(prev, [{ id: "a" }, { id: "c" }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[2]);
  });

  it("sees a reorder of the same rows as a change", () => {
    const prev = [{ id: "a" }, { id: "b" }];
    const out = keepSame(prev, [{ id: "b" }, { id: "a" }]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[1]);
    expect(out[1]).toBe(prev[0]);
  });

  it("takes a longer or shorter list", () => {
    const prev = [{ id: "a" }];
    const longer = keepSame(prev, [{ id: "a" }, { id: "b" }]);
    expect(longer).toHaveLength(2);
    expect(longer[0]).toBe(prev[0]);
    const shorter = keepSame([{ id: "a" }, { id: "b" }], [{ id: "a" }]);
    expect(shorter).toHaveLength(1);
  });
});
