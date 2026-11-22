import { describe, expect, it } from "vitest";
import { firstUnreadId, mergeRead } from "./readCursors";


describe("firstUnreadId", () => {
  const rows = [
    { id: "a", ts: 10, mine: false },
    { id: "b", ts: 20, mine: true },
    { id: "c", ts: 30, mine: false },
    { id: "d", ts: 40, mine: false },
  ];
  it("marks the first line after the cursor that is not the reader's own", () => {
    expect(firstUnreadId(rows, 15)).toBe("c");
  });
  it("marks nothing for a chat never read or already caught up", () => {
    expect(firstUnreadId(rows, 0)).toBeNull();
    expect(firstUnreadId(rows, 40)).toBeNull();
  });
});

describe("mergeRead", () => {
  it("keeps the later place of the two for each chat", () => {
    const phone = { "agent:a": 100, "agent:b": 500 };
    // The laptop read `a` further; `b` it saw less of; `c` only it has.
    const next = mergeRead(phone, { "agent:a": 900, "agent:b": 200, "agent:c": 50 });
    expect(next).toEqual({ "agent:a": 900, "agent:b": 500, "agent:c": 50 });
    expect(phone).toEqual({ "agent:a": 100, "agent:b": 500 });
  });

  it("gives back the same map when nothing moves", () => {
    const map = { "agent:a": 900 };
    expect(mergeRead(map, { "agent:a": 300 })).toBe(map);
    expect(mergeRead(map, null)).toBe(map);
    expect(mergeRead(map, "nope")).toBe(map);
    expect(mergeRead(map, { "agent:a": "late", "agent:b": -1, "agent:c": Infinity })).toBe(map);
  });
});
