import { describe, expect, it } from "vitest";
import { escapeHtml, isLocalHref, renderMarkdown, resolveLocalPath } from "./markdown";

describe("renderMarkdown", () => {
  it("escapes html that came from a bot", () => {
    expect(escapeHtml('<script>&"')).toBe('&lt;script&gt;&amp;"');
    expect(renderMarkdown("<b>hi</b>")).toBe("<p>&lt;b&gt;hi&lt;/b&gt;</p>");
  });

  it("keeps a fenced block verbatim and escaped", () => {
    const html = renderMarkdown("```rust\nfn a<T>() {}\n```");
    expect(html).toBe("<pre><code>fn a&lt;T&gt;() {}</code></pre>");
  });

  it("does not style markdown inside a fence", () => {
    expect(renderMarkdown("```\n**not bold**\n```")).toContain("**not bold**");
  });

  it("marks up inline spans", () => {
    expect(renderMarkdown("**b** *i* `c`")).toBe(
      "<p><strong>b</strong> <em>i</em> <code>c</code></p>",
    );
  });

  it("leaves underscores and stars inside inline code alone", () => {
    expect(renderMarkdown("`social_accounts`에서 `signup_type`, `a*b*c`")).toBe(
      "<p><code>social_accounts</code>에서 <code>signup_type</code>, <code>a*b*c</code></p>",
    );
    expect(renderMarkdown("`a` %%CODE0%%")).toBe("<p><code>a</code> %%CODE0%%</p>");
  });

  it("builds headings and both list kinds", () => {
    expect(renderMarkdown("## 제목")).toBe("<h2>제목</h2>");
    expect(renderMarkdown("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(renderMarkdown("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  it("joins wrapped lines into one paragraph and splits on a blank line", () => {
    expect(renderMarkdown("one\ntwo\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
  });

  it("opens an external link in a new tab", () => {
    expect(renderMarkdown("[go](https://example.com)")).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">go</a>',
    );
  });

  it("takes an image tag from image syntax", () => {
    expect(renderMarkdown("![shot](/tmp/a.png)")).toContain(
      '<img alt="shot" src="/tmp/a.png" />',
    );
  });
});

describe("tables", () => {
  it("builds a table from a header, a delimiter row and body rows", () => {
    expect(renderMarkdown("| ID | 이름 |\n| --- | --- |\n| 4861 | **QA** |\n| 4885 | Dev |")).toBe(
      "<table><thead><tr><th>ID</th><th>이름</th></tr></thead>" +
        "<tbody><tr><td>4861</td><td><strong>QA</strong></td></tr>" +
        "<tr><td>4885</td><td>Dev</td></tr></tbody></table>",
    );
  });

  it("reads alignment, outer pipes are optional, and an escaped pipe stays in its cell", () => {
    expect(renderMarkdown("a | b | c\n:-: | --: | :--\n1 \\| 2 | 3")).toBe(
      '<table><thead><tr><th class="md-center">a</th><th class="md-right">b</th><th>c</th></tr></thead>' +
        '<tbody><tr><td class="md-center">1 | 2</td><td class="md-right">3</td><td></td></tr></tbody></table>',
    );
  });

  it("ends at a blank line and can follow a sentence directly", () => {
    expect(renderMarkdown("결과:\n| a |\n| - |\n| 1 |\n\n끝")).toBe(
      "<p>결과:</p><table><thead><tr><th>a</th></tr></thead>" +
        "<tbody><tr><td>1</td></tr></tbody></table><p>끝</p>",
    );
  });

  it("leaves pipes alone without a matching delimiter row", () => {
    expect(renderMarkdown("a | b\nc | d")).toBe("<p>a | b<br>c | d</p>");
    expect(renderMarkdown("| a | b |\n| --- |")).not.toContain("<table>");
  });
});

describe("resolveLocalPath", () => {
  it("passes through absolute and home paths", () => {
    expect(resolveLocalPath("/tmp/a.png")).toBe("/tmp/a.png");
    expect(resolveLocalPath("~/shots/a.png")).toBe("~/shots/a.png");
  });

  it("reads a file:// url back into a path", () => {
    expect(resolveLocalPath("file:///tmp/a%20b.png")).toBe("/tmp/a b.png");
  });

  it("resolves a relative path against the bot's folder", () => {
    expect(resolveLocalPath("./out/a.png", "/work/app/")).toBe("/work/app/out/a.png");
    expect(resolveLocalPath("out/a.png", "/work/app")).toBe("/work/app/out/a.png");
    expect(resolveLocalPath("out/a.png")).toBeNull();
  });

  it("says no to anything that is already a url", () => {
    for (const src of ["https://x/a.png", "http://x/a.png", "data:image/png;base64,AA", "blob:x", ""]) {
      expect(resolveLocalPath(src), src).toBeNull();
      expect(isLocalHref(src), src).toBe(false);
    }
    expect(isLocalHref("/tmp/a.png")).toBe(true);
  });
});

describe("command and output", () => {
  it("marks an inline-code line that introduces a block", () => {
    const html = renderMarkdown("`echo hi`\n\n```\nhi\n```");
    expect(html).toContain('<p class="md-cmd"><code>echo hi</code></p>');
    expect(html).toContain('<pre class="md-out">');
  });

  it("leaves a block that follows prose alone", () => {
    const html = renderMarkdown("결과예요.\n\n```\nhi\n```");
    expect(html).not.toContain("md-cmd");
    expect(html).not.toContain("md-out");
  });

  it("leaves a block that follows a sentence with code in it alone", () => {
    const html = renderMarkdown("`ls` 를 돌렸어요.\n\n```\nhi\n```");
    expect(html).not.toContain("md-cmd");
  });
});
