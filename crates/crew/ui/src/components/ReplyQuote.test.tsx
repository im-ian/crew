import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The face is the app's Avatar; here it only has to show up, with its bot.
vi.mock("./Avatar", () => ({
  Avatar: ({ className, id }: { className?: string; id: string }) => (
    <span className={className} data-bot={id} />
  ),
}));
import { LocaleProvider } from "../LocaleContext";
import type { AgentInfo } from "../types";
import { ReplyQuote, quoteFrom } from "./ReplyQuote";

const echo = { id: "bot-echo", name: "에코" } as AgentInfo;

function draw(agent: AgentInfo | null, who: string, snippet: string) {
  return renderToStaticMarkup(
    <LocaleProvider>
      <ReplyQuote agent={agent} who={who} snippet={snippet} title="원문 보기" />
    </LocaleProvider>,
  );
}

describe("ReplyQuote", () => {
  it("shows the bot's face and its name in bold, then the words", () => {
    const html = draw(echo, "에코", "**안녕하세요!** 반가워요");
    expect(html).toContain('class="reply-quote"');
    expect(html).toContain('<span class="reply-quote-face" data-bot="bot-echo"></span>');
    expect(html).toContain("<b>에코</b>에게 답장");
    expect(html).toContain('<span class="reply-quote-text">안녕하세요! 반가워요</span>');
  });

  it("has no face for the user's own message", () => {
    const html = draw(null, "민수", "내가 한 말");
    expect(html).not.toContain("reply-quote-face");
    expect(html).toContain("<b>민수</b>에게 답장");
  });
});

describe("quoteFrom", () => {
  it("is no bot for the user, and the bot a message went to otherwise", () => {
    expect(quoteFrom("user")).toBeNull();
    expect(quoteFrom("bot-echo")).toBe("bot-echo");
  });
});
