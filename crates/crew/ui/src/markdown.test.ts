import { describe, expect, it } from "vitest";
import { isLocalHref, mediaKind, messageDefinitions, renderMarkdown, resolveLocalPath } from "./markdown";

/** The rendered html without the newlines markdown-it puts after tags. */
const html = (text: string, source?: string) =>
  renderMarkdown(text, source && messageDefinitions(source)).replace(/>\n/g, ">").trim();

describe("renderMarkdown", () => {
  it("escapes html that came from a bot", () => {
    expect(html("<b>hi</b> & <script>x</script>")).toBe(
      "<p>&lt;b&gt;hi&lt;/b&gt; &amp; &lt;script&gt;x&lt;/script&gt;</p>",
    );
  });

  it("keeps a fenced block verbatim and escaped", () => {
    expect(html("```rust\nfn a<T>() {}\n```")).toBe("<pre><code>fn a&lt;T&gt;() {}</code></pre>");
  });

  it("does not style markdown inside a fence", () => {
    expect(html("```\n**not bold**\n```")).toContain("**not bold**");
  });

  it("marks up inline spans", () => {
    expect(html("**b** *i* `c`")).toBe("<p><strong>b</strong> <em>i</em> <code>c</code></p>");
  });

  it("leaves underscores and stars inside inline code alone", () => {
    expect(html("`social_accounts`에서 `signup_type`, `a*b*c`")).toBe(
      "<p><code>social_accounts</code>에서 <code>signup_type</code>, <code>a*b*c</code></p>",
    );
    expect(html("`a` %%CODE0%%")).toBe("<p><code>a</code> %%CODE0%%</p>");
    expect(html("user_id and created_at")).toBe("<p>user_id and created_at</p>");
  });

  it("keeps emphasis inside the list item it started in", () => {
    expect(html("- **a\n- b**")).toBe("<ul><li>**a</li><li>b**</li></ul>");
  });

  it("builds headings and both list kinds", () => {
    expect(html("## 제목")).toBe("<h2>제목</h2>");
    expect(html("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(html("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  it("joins wrapped lines into one paragraph and splits on a blank line", () => {
    expect(html("one\ntwo\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
  });

  it("links a url", () => {
    expect(html("[go](https://example.com)")).toBe('<p><a href="https://example.com">go</a></p>');
  });

  it("takes an image tag from image syntax", () => {
    expect(html("![shot](/tmp/a.png)")).toBe('<p><img src="/tmp/a.png" alt="shot"></p>');
  });

  it("shows an upload path that contains spaces as an image", () => {
    const path = "/Users/jthefloor/Library/Application Support/crew/uploads/shot";
    expect(html(`![image.png](${path})`)).toBe(`<p><img src="${path}" alt="image.png"></p>`);
    expect(html(`![image.png](<${path}>)`)).toBe(`<p><img src="${path}" alt="image.png"></p>`);
  });

  it("links a file path that contains spaces", () => {
    const path = "/Users/jthefloor/Library/Application Support/crew/uploads/notes.txt";
    expect(html(`[notes.txt](${path})`)).toBe(`<p><a href="${path}">notes.txt</a></p>`);
  });

  it("leaves a spaced picture inside code as text", () => {
    expect(html("`![a](/Users/a/Application Support/x)`")).toBe(
      "<p><code>![a](/Users/a/Application Support/x)</code></p>",
    );
  });

  it("keeps a spaced Windows path as written", () => {
    const path = "C:/Program Files/a.txt";
    expect(html(`[a](${path})`)).toBe(`<p><a href="${path}">a</a></p>`);
    expect(html(`[a](<${path}>)`)).toBe(`<p><a href="${path}">a</a></p>`);
    const img = "C:/Program Files/a.png";
    expect(html(`![a](${img})`)).toBe(`<p><img src="${img}" alt="a"></p>`);
  });

  it("does not nest a link inside a spaced file link", () => {
    const path = "/Users/me/Application Support/file.txt";
    expect(html(`[see [docs](https://example.com) here](${path})`)).toBe(
      `<p>[see <a href="https://example.com">docs</a> here](${path})</p>`,
    );
  });

  it("keeps a quote that is part of a spaced file name", () => {
    const path = "/Users/me/Application Support/My &quot;photo&quot;.png";
    expect(html('![a](/Users/me/Application Support/My "photo".png)')).toBe(
      `<p><img src="${path}" alt="a"></p>`,
    );
  });

  it("leaves a spaced phrase that is not a path as text", () => {
    expect(html("[eta](~ 2 hours left)")).toBe("<p>[eta](~ 2 hours left)</p>");
    expect(html("[a](file: not a path)")).toBe("<p>[a](file: not a path)</p>");
    expect(html("![a](FILE:///tmp/My File.png)")).toBe(
      '<p><img src="FILE:///tmp/My File.png" alt="a"></p>',
    );
  });
});

// Everything a bot listed when asked to show markdown.
describe("the rest of markdown", () => {
  it("has six heading levels", () => {
    expect(html("#### 4\n##### 5\n###### 6")).toBe("<h4>4</h4><h5>5</h5><h6>6</h6>");
  });

  it("strikes through and stacks bold on italic", () => {
    expect(html("~~취소~~ ***둘 다*** __굵게__ _기울임_")).toBe(
      "<p><s>취소</s> <em><strong>둘 다</strong></em> <strong>굵게</strong> <em>기울임</em></p>",
    );
  });

  it("nests lists by indent and takes `+` as a bullet", () => {
    expect(html("+ 배\n  - 신고\n  - 황금")).toBe("<ul><li>배\n<ul><li>신고</li><li>황금</li></ul></li></ul>");
  });

  it("keeps counting a list that picks up after a block", () => {
    expect(html("3. 검증")).toBe('<ol start="3"><li>검증</li></ol>');
  });

  it("checks off a task list", () => {
    expect(html("- [x] 명세\n- [ ] 리뷰")).toBe(
      '<ul><li class="md-task"><input type="checkbox" disabled checked>명세</li>' +
        '<li class="md-task"><input type="checkbox" disabled>리뷰</li></ul>',
    );
  });

  it("gives a link its title", () => {
    expect(html('[안내](https://example.com "툴팁")')).toBe(
      '<p><a href="https://example.com" title="툴팁">안내</a></p>',
    );
  });

  it("resolves a reference link", () => {
    expect(html("[가이드][guide]를 본다.\n\n[guide]: https://example.com/guide")).toBe(
      '<p><a href="https://example.com/guide">가이드</a>를 본다.</p>',
    );
  });

  it("links a bare url, but not a file name that ends in a country code", () => {
    expect(html("https://x.ai 와 README.md, main.rs, a@b.co")).toBe(
      '<p><a href="https://x.ai">https://x.ai</a> 와 README.md, main.rs, a@b.co</p>',
    );
  });

  it("shows a three-backtick block inside four backticks", () => {
    expect(html("````markdown\n```python\nx = 1\n```\n````")).toBe(
      "<pre><code>```python\nx = 1\n```</code></pre>",
    );
  });

  it("quotes", () => {
    expect(html("> 측정할 수 없으면\n>\n> — 격언")).toBe(
      "<blockquote><p>측정할 수 없으면</p><p>— 격언</p></blockquote>",
    );
  });

  it("draws a rule", () => {
    expect(html("위\n\n---\n\n아래")).toBe("<p>위</p><hr><p>아래</p>");
  });

  it("breaks a line at `<br>`, and keeps any other tag as text", () => {
    expect(html("| a |\n| - |\n| 1<br>2 |")).toContain("<td>1<br>2</td>");
    expect(html("a<br/>b <i>c</i>")).toBe("<p>a<br>b &lt;i&gt;c&lt;/i&gt;</p>");
  });

  it("shows a backslash-escaped mark as itself", () => {
    expect(html("\\| \\*a\\* \\$1$")).toBe("<p>| *a* $1$</p>");
  });

  it("numbers footnotes by first reference and keeps each note where it was written", () => {
    expect(html("가[^b] 나[^a] 다[^b]\n\n[^a]: 에이\n[^b]: 비")).toBe(
      '<p>가<sup class="md-fnref">1</sup> 나<sup class="md-fnref">2</sup> 다<sup class="md-fnref">1</sup></p>' +
        '<p class="md-footnote"><sup>2</sup> 에이</p><p class="md-footnote"><sup>1</sup> 비</p>',
    );
    expect(html("정의 없는 [^x]")).toBe("<p>정의 없는 [^x]</p>");
  });

  it("runs a note on to its next line, as a paragraph does", () => {
    expect(html("본문[^1]\n\n[^1]: 첫 줄\n둘째 줄\n[^2]: 다음")).toBe(
      '<p>본문<sup class="md-fnref">1</sup></p>' +
        '<p class="md-footnote"><sup>1</sup> 첫 줄<br>둘째 줄</p><p class="md-footnote"><sup>2</sup> 다음</p>',
    );
  });

  it("finds a link or footnote defined in another balloon of the message", () => {
    const source = "[가이드][g]와 각주[^1]\n\n[g]: https://g.dev\n\n[^1]: 내용";
    expect(messageDefinitions("정의 없음")).toBe("");
    expect(html("[가이드][g]와 각주[^1]", source)).toBe(
      '<p><a href="https://g.dev">가이드</a>와 각주<sup class="md-fnref">1</sup></p>',
    );
    expect(html("[^1]: 내용", source)).toBe('<p class="md-footnote"><sup>1</sup> 내용</p>');
  });

  it("typesets math, and leaves money alone", () => {
    expect(html("수식 $E = mc^2$처럼")).toMatch(/^<p>수식 <span class="md-math"><span class="katex">.*<\/span><\/span>처럼<\/p>$/);
    expect(html("$$\n\\frac{a}{b}\n$$")).toMatch(/^<div class="md-math md-math-block"><span class="katex-display">/);
    expect(html("$5 and $10, $ x$")).toBe("<p>$5 and $10, $ x$</p>");
    expect(html("echo $HOME/$USER")).toBe("<p>echo $HOME/$USER</p>");
    expect(html("$x `foo$`")).toBe("<p>$x <code>foo$</code></p>");
  });

  it("keeps a stray `$$` from swallowing the paragraphs after it", () => {
    expect(html("$$ 비용\n\n다음 $$")).toBe("<p>$$ 비용</p><p>다음 $$</p>");
  });

  it("shows bad TeX as an error, not a crash", () => {
    expect(html("$\\frac{a$")).toContain("katex-error");
  });

  it("opens files, and refuses a script link", () => {
    expect(html("[f](file:///tmp/a.png) [g](./문서.md) [x](javascript:alert(1))")).toBe(
      '<p><a href="file:///tmp/a.png">f</a> <a href="./문서.md">g</a> [x](javascript:alert(1))</p>',
    );
  });
});

describe("tables", () => {
  it("builds a table from a header, a delimiter row and body rows", () => {
    expect(html("| ID | 이름 |\n| --- | --- |\n| 4861 | **QA** |\n| 4885 | Dev |")).toBe(
      "<table><thead><tr><th>ID</th><th>이름</th></tr></thead>" +
        "<tbody><tr><td>4861</td><td><strong>QA</strong></td></tr>" +
        "<tr><td>4885</td><td>Dev</td></tr></tbody></table>",
    );
  });

  it("reads alignment, outer pipes are optional, and an escaped pipe stays in its cell", () => {
    expect(html("a | b | c\n:-: | --: | :--\n1 \\| 2 | 3")).toBe(
      '<table><thead><tr><th style="text-align:center">a</th><th style="text-align:right">b</th><th style="text-align:left">c</th></tr></thead>' +
        '<tbody><tr><td style="text-align:center">1 | 2</td><td style="text-align:right">3</td><td style="text-align:left"></td></tr></tbody></table>',
    );
  });

  it("ends at a blank line and can follow a sentence directly", () => {
    expect(html("결과:\n| a |\n| - |\n| 1 |\n\n끝")).toBe(
      "<p>결과:</p><table><thead><tr><th>a</th></tr></thead>" +
        "<tbody><tr><td>1</td></tr></tbody></table><p>끝</p>",
    );
  });

  it("marks up each cell on its own", () => {
    expect(html("| user_id | created_at | c |\n| --- | --- | --- |\n| **a | b** | `c` |")).toBe(
      "<table><thead><tr><th>user_id</th><th>created_at</th><th>c</th></tr></thead>" +
        "<tbody><tr><td>**a</td><td>b**</td><td><code>c</code></td></tr></tbody></table>",
    );
  });

  it("ends at a line that opens another block", () => {
    expect(html("| a |\n| - |\n| 1 |\n- 참고: x | y")).toBe(
      "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>" +
        "<ul><li>참고: x | y</li></ul>",
    );
  });

  it("leaves pipes alone without a matching delimiter row", () => {
    expect(html("a | b\nc | d")).toBe("<p>a | b<br>c | d</p>");
    expect(html("| a | b |\n| --- |")).not.toContain("<table>");
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
    for (const src of ["https://x/a.png", "http://x/a.png", "data:image/png;base64,AA", "blob:x", "mailto:a@b.co", "#notes", ""]) {
      expect(resolveLocalPath(src), src).toBeNull();
      expect(isLocalHref(src), src).toBe(false);
    }
    expect(isLocalHref("/tmp/a.png")).toBe(true);
    expect(isLocalHref("C:\\work\\a.png")).toBe(true);
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

  it("leaves a command in a tight list unmarked, output and all", () => {
    const html = renderMarkdown("- `ls`\n  ```\n  out\n  ```");
    expect(html).not.toContain("md-cmd");
    expect(html).not.toContain("md-out");
  });

  it("leaves a block that follows a sentence with code in it alone", () => {
    const html = renderMarkdown("`ls` 를 돌렸어요.\n\n```\nhi\n```");
    expect(html).not.toContain("md-cmd");
  });
});

describe("image albums", () => {
  it("groups two or more pictures into an album and leaves one alone", () => {
    const one = "![a](/tmp/a.png)";
    const two = "![a](/tmp/a.png)\n![b](/tmp/b.png)";
    const three = "![a](/tmp/a.png)\n\n![b](/tmp/b.png)\n\n![c](/tmp/c.png)";
    expect(html(one)).toBe('<p><img src="/tmp/a.png" alt="a"></p>');
    expect(html(two)).toBe(
      '<div class="md-gallery is-pair" data-count="2"><img src="/tmp/a.png" alt="a"><img src="/tmp/b.png" alt="b"></div>',
    );
    expect(html(three)).toBe(
      '<div class="md-gallery is-trio" data-count="3"><img src="/tmp/a.png" alt="a"><img src="/tmp/b.png" alt="b"><img src="/tmp/c.png" alt="c"></div>',
    );
    expect(html("see this\n\n![a](/tmp/a.png)\n![b](/tmp/b.png)")).toBe(
      '<p>see this</p><div class="md-gallery is-pair" data-count="2"><img src="/tmp/a.png" alt="a"><img src="/tmp/b.png" alt="b"></div>',
    );
  });

  it("leaves a video or a sound file out of an album", () => {
    expect(html("![a](/tmp/a.mp4)\n\n![b](/tmp/b.mp4)")).toBe(
      '<p><img src="/tmp/a.mp4" alt="a"></p><p><img src="/tmp/b.mp4" alt="b"></p>',
    );
    expect(html("![a](/tmp/a.png)\n\n![b](/tmp/b.mp3)")).toBe(
      '<p><img src="/tmp/a.png" alt="a"></p><p><img src="/tmp/b.mp3" alt="b"></p>',
    );
  });
});

describe("mediaKind", () => {
  it("trusts a mime type over the file name", () => {
    expect(mediaKind("clipmp4", "video/mp4")).toBe("video");
    expect(mediaKind("song", "audio/mpeg")).toBe("audio");
    expect(mediaKind("clip.mp4", "image/png")).toBeNull();
  });

  it("reads an extension and ignores a query or a fragment", () => {
    expect(mediaKind("https://cdn.example/a.mp4?x=1#t=0.1")).toBe("video");
    expect(mediaKind("/tmp/a.MP3")).toBe("audio");
    expect(mediaKind("/tmp/notes.txt")).toBeNull();
    expect(mediaKind("/tmp/clipmp4")).toBeNull();
  });

  it("keeps a media kind on an upload path that has no extension", () => {
    const path = "/Users/jthefloor/Library/Application Support/crew/uploads/1-clipmp4";
    expect(html(`[clip.mp4](<${path}> "video")`)).toBe(
      `<p><a href="${path}" title="video">clip.mp4</a></p>`,
    );
    expect(html(`[song.mp3](/tmp/1-songmp3 "audio")`)).toBe(
      '<p><a href="/tmp/1-songmp3" title="audio">song.mp3</a></p>',
    );
  });
});
