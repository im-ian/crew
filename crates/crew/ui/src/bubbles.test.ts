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
    // A stray marker used to hold every later blank line shut.
    expect(splitBubbles("`a\n\nb")).toEqual(["`a", "b"]);
    expect(splitBubbles("wrap it in ``` fences.\n\nnext")).toEqual([
      "wrap it in ``` fences.",
      "next",
    ]);
  });

  it("takes a line of only spaces, or a CRLF break, as blank", () => {
    expect(splitBubbles("first\n  \nsecond")).toEqual(["first", "second"]);
    expect(splitBubbles("first\r\n\r\nsecond")).toEqual(["first", "second"]);
  });

  it("keeps a single line whole", () => {
    expect(splitBubbles("한 줄이면 하나")).toEqual(["한 줄이면 하나"]);
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

  it("never splits a line at a period, whatever follows it", () => {
    for (const text of [
      "설정파일.json을 열었어요",
      "React.Component를 상속해요",
      "README.MD 를 봐",
      '그는 "끝났어."라고 말했다',
      "*끝났어.*다음으로",
      "**끝났어.**다음으로",
      "음...그래요",
      "Mr. Smith arrived",
      "버전 1.5 입니다",
      "`a.b` 를 봐",
      "확인했어요.이제 고칠게요.",
    ]) {
      expect(splitBubbles(text)).toEqual([text]);
    }
  });

  it("never splits inside a fenced block", () => {
    const text = "이거 봐.\n\n```rust\nfn a() {}\n\nfn b() {}\n```";
    expect(splitBubbles(text)).toEqual([text]);
    const nested = "````md\n```js\nx\n\n```\n````";
    expect(splitBubbles(nested + "\n\n끝")).toEqual([nested, "끝"]);
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

  it("never splits inside a table", () => {
    const table = "| 클래스 | 설명 |\n| --- | --- |\n| React.Component | 기본 |\n| a | 완료.**다음** |";
    expect(splitBubbles(table + "\n\n끝.다음")).toEqual([table, "끝.다음"]);
    const bare = "상태 | 메모\n--- | ---\n4861 | 완료.다음 단계";
    expect(splitBubbles(bare)).toEqual([bare]);
  });
});
