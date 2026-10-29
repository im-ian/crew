import { describe, expect, it } from "vitest";
import { firstUnreadId } from "./readCursors";


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
