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
