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

  it("keeps the sentences of one paragraph in one balloon", () => {
    expect(splitBubbles("확인했어요. 이제 고칠게요.")).toEqual([
      "확인했어요. 이제 고칠게요.",
    ]);
    expect(splitBubbles("확인했어요.\n이제 고칠게요.")).toEqual([
      "확인했어요.\n이제 고칠게요.",
    ]);
  });

  it("gives each paragraph of a long answer its own balloon", () => {
    const text =
      "계정은 **3개**입니다. 세 계정 모두 활성 상태입니다.\n\n" +
      "`social_accounts`에서 3건입니다. 비활성 연결은 없습니다. 나머지 1명은 나중에 연결했습니다.";
    expect(splitBubbles(text)).toEqual([
      "계정은 **3개**입니다. 세 계정 모두 활성 상태입니다.",
      "`social_accounts`에서 3건입니다. 비활성 연결은 없습니다. 나머지 1명은 나중에 연결했습니다.",
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
    expect(splitBubbles(text)).toEqual([text]);
  });

  it("keeps a command and its output in one balloon", () => {
    const text = "`echo hi`\n\n```\nhi\n```\n\n`ls -1`\n\n```\n```";
    expect(splitBubbles(text)).toEqual([
      "`echo hi`\n\n```\nhi\n```",
      "`ls -1`\n\n```\n```",
    ]);
  });

  it("still starts a new balloon after a block ends", () => {
    expect(splitBubbles("```\nout\n```\n\n끝났어요.")).toEqual([
      "```\nout\n```",
      "끝났어요.",
    ]);
  });

  it("never splits inside inline code", () => {
    expect(splitBubbles("`a.b` 를 봐")).toEqual(["`a.b` 를 봐"]);
  });

  it("splits after a bold run that ended a sentence", () => {
    expect(splitBubbles("**끝났어.**다음으로")).toEqual(["**끝났어.**", "다음으로"]);
  });

  it("never splits inside a table row", () => {
    const table = "| 클래스 | 설명 |\n| --- | --- |\n| React.Component | 기본 |\n| a | 완료.**다음** |";
    expect(splitBubbles(table + "\n끝.다음")).toEqual([table + "\n끝.", "다음"]);
  });
});
