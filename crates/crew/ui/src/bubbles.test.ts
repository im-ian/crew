import { describe, expect, it } from "vitest";
import { splitBubbles } from "./bubbles";

describe("splitBubbles", () => {
  it("returns nothing for empty text", () => {
    expect(splitBubbles("")).toEqual([]);
    expect(splitBubbles("   \n\n  ")).toEqual([]);
  });

  it("breaks on a blank line", () => {
    expect(splitBubbles("first\n\nsecond")).toEqual(["first", "second"]);
    expect(splitBubbles("first\n\n\n\nsecond")).toEqual(["first", "second"]);
  });

  it("keeps a single line whole", () => {
    expect(splitBubbles("한 줄이면 하나")).toEqual(["한 줄이면 하나"]);
  });

  it("splits Korean sentences that were glued together", () => {
    expect(splitBubbles("확인했어요.이제 고칠게요.")).toEqual([
      "확인했어요.",
      "이제 고칠게요.",
    ]);
  });

  it("splits a Korean sentence that has a space after the period", () => {
    expect(splitBubbles("확인했어요. 이제 고칠게요.")).toEqual([
      "확인했어요.",
      "이제 고칠게요.",
    ]);
  });

  it("splits a sentence that continues on the next line", () => {
    expect(splitBubbles("확인했어요.\n이제 고칠게요.")).toEqual([
      "확인했어요.",
      "이제 고칠게요.",
    ]);
  });

  it("does not split an English abbreviation on the same line", () => {
    expect(splitBubbles("Mr. Smith arrived")).toEqual(["Mr. Smith arrived"]);
  });

  it("leaves a decimal or an ellipsis inside one bubble", () => {
    expect(splitBubbles("버전 1.5 입니다")).toEqual(["버전 1.5 입니다"]);
  });

  it("never splits inside a fenced block", () => {
    const text = "이거 봐.\n\n```rust\nfn a() {}\n\nfn b() {}\n```";
    expect(splitBubbles(text)).toEqual(["이거 봐.", "```rust\nfn a() {}\n\nfn b() {}\n```"]);
  });

  it("never splits inside inline code", () => {
    expect(splitBubbles("`a.b` 를 봐")).toEqual(["`a.b` 를 봐"]);
  });

  it("splits after a bold run that ended a sentence", () => {
    expect(splitBubbles("**끝났어.**다음으로")).toEqual(["**끝났어.**", "다음으로"]);
  });
});
