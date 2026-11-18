import { describe, expect, it } from "vitest";
import { oneLine, plainText, replyBody, splitReply, wrapReply } from "./reply";

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

describe("plainText", () => {
  it("drops markdown marks and joins list items with a dot", () => {
    expect(
      plainText(
        "**다음 할 일**\n- 던전 층을 열지만 남았어요.\n- `queue`에 넣을게요. [보드](https://x.dev)에서 봐요.",
      ),
    ).toBe("다음 할 일 · 던전 층을 열지만 남았어요. · queue에 넣을게요. 보드에서 봐요.");
  });

  it("keeps a heading apart and a paragraph's lines together", () => {
    expect(plainText("## Plan\nfirst line\nsecond line\n\n1. one\n2) two")).toBe(
      "Plan · first line second line · one · two",
    );
  });

  it("leaves words with underscores, hyphens and lone stars alone", () => {
    expect(plainText("snake_case_name stays, 1 - 2 = -1, 3 * 4")).toBe(
      "snake_case_name stays, 1 - 2 = -1, 3 * 4",
    );
    expect(plainText("an *em* word and _this_ one, ~~gone~~ \\*kept\\*")).toBe(
      "an em word and this one, gone *kept*",
    );
  });

  it("skips code fences and quote marks", () => {
    expect(plainText("> quoted\n```ts\nconst a = 1;\n```")).toBe("quoted const a = 1;");
  });

  it("only loses the marks of a snippet stored on one line", () => {
    expect(plainText("**다음 할 일** - 던전 층")).toBe("다음 할 일 - 던전 층");
  });
});

describe("wrapReply snippet", () => {
  it("stores the plain words of the quoted message", () => {
    const raw = wrapReply("ok", { id: "1-1", from: "bob", snippet: "**Next**\n- ship it" });
    expect(splitReply(raw).reply?.snippet).toBe("Next · ship it");
  });
});
