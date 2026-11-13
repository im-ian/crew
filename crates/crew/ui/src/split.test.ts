import { describe, expect, it } from "vitest";
import {
  closeSlot,
  dropInto,
  dropSide,
  openSlot,
  openSplit,
  placeOpen,
  prunePanes,
  type Split,
} from "./split";

const box = { left: 0, top: 0, width: 800, height: 600 };

describe("openSplit", () => {
  it("keeps the open chat in the first half and waits on the second", () => {
    expect(openSplit(null, "row", "a")).toEqual({ dir: "row", panes: ["a", null], target: 1 });
  });

  it("does nothing with no chat open", () => {
    expect(openSplit(null, "col", null)).toBeNull();
  });

  it("turns a split that is already open", () => {
    const cur: Split = { dir: "row", panes: ["a", "b"], target: 0 };
    expect(openSplit(cur, "col", "a")).toEqual({ ...cur, dir: "col" });
    expect(openSplit(cur, "row", "a")).toBe(cur);
  });
});

describe("placeOpen", () => {
  it("fills the empty half the pick was waiting for", () => {
    const cur = openSplit(null, "row", "a");
    expect(placeOpen(cur, "b")).toEqual({ dir: "row", panes: ["a", "b"], target: 1 });
  });

  it("replaces the bot in the target half", () => {
    const cur: Split = { dir: "row", panes: ["a", "b"], target: 0 };
    expect(placeOpen(cur, "c")).toEqual({ dir: "row", panes: ["c", "b"], target: 0 });
  });

  it("moves the keys to a bot that is already in a half", () => {
    const cur: Split = { dir: "row", panes: ["a", "b"], target: 0 };
    expect(placeOpen(cur, "b")).toEqual({ ...cur, target: 1 });
    expect(placeOpen(cur, "a")).toBe(cur);
  });

  it("keeps waiting on the empty half while the open chat stays", () => {
    const cur = openSplit(null, "row", "a");
    expect(placeOpen(cur, "a")).toBe(cur);
  });

  it("leaves no split alone", () => {
    expect(placeOpen(null, "a")).toBeNull();
  });
});

describe("openSlot", () => {
  it("is the half the open chat is in", () => {
    const cur: Split = { dir: "col", panes: ["a", "b"], target: 0 };
    expect(openSlot(cur, "b")).toBe(1);
    expect(openSlot(cur, "c")).toBeNull();
    expect(openSlot(null, "a")).toBe(0);
    expect(openSlot(null, null)).toBeNull();
  });
});

describe("closeSlot", () => {
  it("keeps the other half", () => {
    const cur: Split = { dir: "row", panes: ["a", "b"], target: 0 };
    expect(closeSlot(cur, 0)).toEqual({ keep: "b" });
    expect(closeSlot(cur, 1)).toEqual({ keep: "a" });
    expect(closeSlot({ ...cur, panes: ["a", null] }, 0)).toEqual({ keep: null });
  });
});

describe("prunePanes", () => {
  it("empties the half of a bot that is gone", () => {
    const cur: Split = { dir: "row", panes: ["a", "b"], target: 0 };
    expect(prunePanes(cur, new Set(["a"]))).toEqual({ ...cur, panes: ["a", null] });
    expect(prunePanes(cur, new Set(["a", "b"]))).toBe(cur);
    expect(prunePanes(cur, new Set())).toBeNull();
  });
});

describe("dropSide", () => {
  it("picks the nearest edge", () => {
    expect(dropSide(50, 300, box)).toEqual({ dir: "row", slot: 0 });
    expect(dropSide(750, 300, box)).toEqual({ dir: "row", slot: 1 });
    expect(dropSide(400, 40, box)).toEqual({ dir: "col", slot: 0 });
    expect(dropSide(400, 560, box)).toEqual({ dir: "col", slot: 1 });
  });
});

describe("dropInto", () => {
  it("splits with the open chat in the other half", () => {
    expect(dropInto(null, "b", { dir: "row", slot: 1 }, "a")).toEqual({
      dir: "row",
      panes: ["a", "b"],
      target: 1,
    });
    expect(dropInto(null, "b", { dir: "col", slot: 0 }, "a")).toEqual({
      dir: "col",
      panes: ["b", "a"],
      target: 0,
    });
  });

  it("leaves the other half empty when the open chat is the one dropped", () => {
    expect(dropInto(null, "a", { dir: "row", slot: 1 }, "a")).toEqual({
      dir: "row",
      panes: [null, "a"],
      target: 1,
    });
  });

  it("replaces a half, or swaps when the bot was in the other one", () => {
    const cur: Split = { dir: "row", panes: ["a", "b"], target: 0 };
    expect(dropInto(cur, "c", { dir: "row", slot: 1 }, "a")).toEqual({
      dir: "row",
      panes: ["a", "c"],
      target: 1,
    });
    expect(dropInto(cur, "a", { dir: "col", slot: 1 }, "a")).toEqual({
      dir: "col",
      panes: ["b", "a"],
      target: 1,
    });
  });
});
