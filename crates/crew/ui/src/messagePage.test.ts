import { describe, expect, it } from "vitest";
import { mergeAbove, mergeTail, pollStart } from "./messagePage";
import type { ChatMessage } from "./types";

const row = (i: number, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `m${i}`, role: "assistant", from: "a", text: `${i}`, ts: 1000 + i, ...extra }) as ChatMessage;
const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => row(from + k));
const ids = (list: ChatMessage[]) => list.map((m) => m.id);

describe("pollStart", () => {
  it("asks for the last rows, never above the window", () => {
    expect(pollStart({ start: 800, total: 1000 }, rows(800, 1000), 200)).toBe(800);
    expect(pollStart({ start: 400, total: 1000 }, rows(400, 1000), 200)).toBe(800);
    expect(pollStart({ start: 0, total: 50 }, rows(0, 50), 200)).toBe(0);
  });

  it("reaches back to a loaded card that still waits, so its answer shows", () => {
    const loaded = rows(400, 1000);
    loaded[10] = row(410, { choice: { id: "c", questions: [], state: "pending" } });
    expect(pollStart({ start: 400, total: 1000 }, loaded, 200)).toBe(410);
    loaded[10] = row(410, { choice: { id: "c", questions: [], state: "answered" } });
    expect(pollStart({ start: 400, total: 1000 }, loaded, 200)).toBe(800);
  });
});

describe("mergeTail", () => {
  it("keeps the older rows and takes the new tail", () => {
    const merged = mergeTail({ start: 400, total: 1000 }, rows(400, 1000), {
      messages: rows(800, 1003),
      start: 800,
      total: 1003,
    });
    expect(merged.win).toEqual({ start: 400, total: 1003 });
    expect(ids(merged.rows)).toEqual(ids(rows(400, 1003)));
  });

  it("takes a page that starts at or above the window whole", () => {
    const first = mergeTail(undefined, [], { messages: rows(800, 1000), start: 800, total: 1000 });
    expect(first.win).toEqual({ start: 800, total: 1000 });
    // A cleared chat: its new tail starts above the old window.
    const cleared = mergeTail({ start: 400, total: 1000 }, rows(400, 1000), { messages: rows(0, 3), start: 0, total: 3 });
    expect(ids(cleared.rows)).toEqual(["m0", "m1", "m2"]);
  });
});

describe("mergeAbove", () => {
  it("puts older rows in front", () => {
    const merged = mergeAbove({ start: 800, total: 1000 }, rows(800, 1000), { messages: rows(600, 800), start: 600, total: 1000 });
    expect(merged.win).toEqual({ start: 600, total: 1000 });
    expect(ids(merged.rows)).toEqual(ids(rows(600, 1000)));
  });

  it("ignores a page that is not above", () => {
    const merged = mergeAbove({ start: 800, total: 1000 }, rows(800, 1000), { messages: [], start: 800, total: 1000 });
    expect(merged.win).toEqual({ start: 800, total: 1000 });
  });
});
