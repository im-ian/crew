import { describe, expect, it } from "vitest";
import { threadFaceId, type FaceLine } from "./threadFace";

function line(partial: Partial<FaceLine> & Pick<FaceLine, "id" | "role" | "from">): FaceLine {
  return partial;
}

describe("threadFaceId", () => {
  it("uses the latest line from this bot", () => {
    const messages = [
      line({ id: "a1", role: "assistant", from: "bot" }),
      line({ id: "u", role: "user", from: "user" }),
      line({ id: "a2", role: "assistant", from: "bot" }),
    ];
    expect(threadFaceId(messages, "bot", null)).toBe("a2");
  });

  it("skips a line that waits, or that belongs beside the thread", () => {
    const messages = [
      line({ id: "a1", role: "assistant", from: "bot" }),
      line({ id: "note", role: "assistant", from: "bot", peer: "other" }),
      line({ id: "q", role: "assistant", from: "bot", queued: true }),
    ];
    expect(threadFaceId(messages, "bot", null)).toBe("a1");
  });

  it("gives the spot to the typing row", () => {
    const messages = [line({ id: "a1", role: "assistant", from: "bot" })];
    expect(threadFaceId(messages, "bot", "working-bot")).toBe("working-bot");
  });

  it("is empty until the bot has spoken", () => {
    expect(threadFaceId([], "bot", null)).toBeNull();
    expect(threadFaceId([], null, null)).toBeNull();
  });
});
