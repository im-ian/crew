import { describe, expect, it } from "vitest";
import { oneLine, replyBody, splitReply, wrapReply } from "./reply";

describe("oneLine", () => {
  it("collapses whitespace and clips", () => {
    expect(oneLine("  hello\nthere  ")).toBe("hello there");
    expect(oneLine("abcdefghij", 6)).toBe("abcdef…");
    expect(oneLine("한글메시지입니다", 4)).toBe("한글메시…");
  });
});

describe("wrapReply / splitReply", () => {
  it("round-trips a reply head and leaves the body alone", () => {
    const raw = wrapReply("got it", {
      id: "171-2",
      from: "alice",
      snippet: "please review the hero",
    });
    expect(raw).toBe(
      "[crew reply:171-2 from:alice]\nplease review the hero\n\ngot it",
    );
    expect(splitReply(raw)).toEqual({
      reply: {
        id: "171-2",
        from: "alice",
        snippet: "please review the hero",
      },
      body: "got it",
    });
    expect(replyBody(raw)).toBe("got it");
  });

  it("does not wrap twice", () => {
    const once = wrapReply("ok", { id: "1-1", from: "bob", snippet: "hi" });
    const twice = wrapReply(once, { id: "9-9", from: "cara", snippet: "later" });
    expect(splitReply(twice)).toEqual({
      reply: { id: "9-9", from: "cara", snippet: "later" },
      body: "ok",
    });
  });

  it("leaves ordinary text alone", () => {
    expect(splitReply("hello")).toEqual({ reply: null, body: "hello" });
    expect(splitReply("[crew from:user]\nhello")).toEqual({
      reply: null,
      body: "[crew from:user]\nhello",
    });
  });

  it("keeps a from value that contains a colon", () => {
    const raw = wrapReply("on it", {
      id: "2-1",
      from: "to:beta",
      snippet: "ping",
    });
    expect(splitReply(raw).reply).toEqual({
      id: "2-1",
      from: "to:beta",
      snippet: "ping",
    });
  });
});
