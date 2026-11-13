import { describe, expect, it } from "vitest";
import { addAi, aiListOf, dropIndex, moveAi, removeAi, startingList, type AiChoice } from "./aiList";
import type { CliKind } from "./types";

const grok: AiChoice = { cli: "grok", model: "", effort: "", cmd: "" };
const claude: AiChoice = { cli: "claude", model: "opus", effort: "high", cmd: "" };
const codex: AiChoice = { cli: "codex", model: "", effort: "", cmd: "" };
const ORDER: CliKind[] = ["grok", "claude", "codex", "agy", "gemini", "copilot", "opencode", "custom"];

describe("aiList", () => {
  it("moves the old single default to the top of the list", () => {
    expect(startingList(null, claude)).toEqual([claude]);
    expect(startingList([], claude)).toEqual([claude]);
    expect(startingList([grok, codex], claude)).toEqual([grok, codex]);
  });

  it("reads what the daemon kept and drops what is not an AI", () => {
    expect(aiListOf(null)).toBeNull();
    expect(aiListOf([])).toBeNull();
    expect(aiListOf([{ cli: "claude", model: "opus", effort: "high" }, 3, { cli: "nope" }, { cli: "grok" }])).toEqual([
      claude,
      grok,
    ]);
    expect(aiListOf([{ cli: "nope" }])).toBeNull();
  });

  it("adds the next CLI the list does not have", () => {
    expect(addAi([grok], ORDER).map((a) => a.cli)).toEqual(["grok", "claude"]);
    expect(addAi([grok, claude], ORDER)[2].cli).toBe("codex");
  });

  it("keeps the last AI", () => {
    expect(removeAi([grok], 0)).toEqual([grok]);
    expect(removeAi([grok, claude, codex], 1)).toEqual([grok, codex]);
  });

  it("moves an AI up and down", () => {
    expect(moveAi([grok, claude, codex], 2, 0)).toEqual([codex, grok, claude]);
    expect(moveAi([grok, claude, codex], 0, 1)).toEqual([claude, grok, codex]);
    expect(moveAi([grok, claude], 1, 5)).toEqual([grok, claude]);
  });

  it("drops a dragged row where the pointer is", () => {
    const mids = [10, 30, 50];
    // The top row dragged below the second one's middle takes its place.
    expect(dropIndex(mids, 35, 0)).toBe(1);
    expect(dropIndex(mids, 99, 0)).toBe(2);
    // The bottom row dragged above the first one's middle goes first.
    expect(dropIndex(mids, 2, 2)).toBe(0);
    // Not past a neighbour's middle: it stays.
    expect(dropIndex(mids, 25, 1)).toBe(1);
  });
});
