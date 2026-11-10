import { describe, expect, it } from "vitest";
import { stepQueuePick, waitingEdit, waitingIds } from "./queuePick";
import type { TFn } from "./i18n";

const ids = ["a", "b", "c"];

describe("waitingIds", () => {
  it("keeps user lines that are still waiting, oldest first", () => {
    expect(
      waitingIds([
        { id: "a", role: "user", queued: true },
        { id: "b", role: "assistant", queued: true },
        { id: "c", role: "user" },
        { id: "d", role: "user", queued: true },
      ]),
    ).toEqual(["a", "d"]);
  });
});

describe("stepQueuePick", () => {
  it("starts at the newest and walks toward the older ones", () => {
    expect(stepQueuePick(ids, null, "prev")).toBe("c");
    expect(stepQueuePick(ids, "c", "prev")).toBe("b");
    expect(stepQueuePick(ids, "b", "prev")).toBe("a");
    expect(stepQueuePick(ids, "a", "prev")).toBe("a");
  });

  it("walks back toward the newest and clears past it", () => {
    expect(stepQueuePick(ids, "a", "next")).toBe("b");
    expect(stepQueuePick(ids, "b", "next")).toBe("c");
    expect(stepQueuePick(ids, "c", "next")).toBeNull();
    expect(stepQueuePick(ids, null, "next")).toBeNull();
  });

  it("treats a line that already left as no selection", () => {
    expect(stepQueuePick(ids, "gone", "prev")).toBe("c");
    expect(stepQueuePick(ids, "gone", "next")).toBeNull();
    expect(stepQueuePick([], "a", "prev")).toBeNull();
  });
});

describe("waitingEdit", () => {
  const t = ((key: string) => (key === "thread.you" ? "나" : key)) as TFn;

  it("opens the body and keeps a reply quote", () => {
    const text = "[crew reply:m1 from:bot-a]\n앞서 한 말\n\n고친 문장";
    expect(waitingEdit(text, [{ id: "bot-a", name: "에이" } as never], t)).toEqual({
      body: "고친 문장",
      reply: { id: "m1", from: "bot-a", who: "에이", text: "앞서 한 말" },
    });
  });

  it("leaves a line with no quote as its own text", () => {
    expect(waitingEdit("그냥", [], t)).toEqual({ body: "그냥", reply: null });
  });
});
