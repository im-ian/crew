import { describe, expect, it } from "vitest";
import {
  injectMentionChips,
  mentionRuns,
  mentionText,
  resolveMention,
  trimMentionPunct,
} from "./mentions";
import type { AgentInfo } from "./types";

function agent(id: string, name: string): AgentInfo {
  return { id, name, status: "idle", cmd: ["cat"], cwd: "/tmp", routines: [] };
}

const agents = [agent("alpha", "Alpha"), agent("gamma", "춘식이")];

describe("resolveMention", () => {
  it("matches an id or a display name, either case", () => {
    expect(resolveMention("alpha", agents)?.id).toBe("alpha");
    expect(resolveMention("ALPHA", agents)?.id).toBe("alpha");
    expect(resolveMention("춘식이", agents)?.id).toBe("gamma");
    expect(resolveMention("nobody", agents)).toBeUndefined();
  });
});

describe("trimMentionPunct", () => {
  it("drops trailing punctuation only", () => {
    expect(trimMentionPunct("alpha,")).toBe("alpha");
    expect(trimMentionPunct("alpha)!?")).toBe("alpha");
    expect(trimMentionPunct("al.pha")).toBe("al.pha");
  });
});

describe("injectMentionChips", () => {
  it("turns a known mention into a chip", () => {
    expect(injectMentionChips("<p>@alpha 봐줘</p>", agents)).toBe(
      '<p><span class="mention-chip" data-mention="alpha"></span> 봐줘</p>',
    );
  });

  it("keeps trailing punctuation outside the chip", () => {
    expect(injectMentionChips("<p>@alpha, 봐줘</p>", agents)).toContain(
      '"alpha"></span>, 봐줘',
    );
  });

  it("leaves an unknown mention as written", () => {
    expect(injectMentionChips("<p>@nobody</p>", agents)).toBe("<p>@nobody</p>");
  });

  it("ignores an @ glued to the end of a word", () => {
    expect(injectMentionChips("<p>mail@alpha</p>", agents)).toBe("<p>mail@alpha</p>");
  });

  it("does not touch code, pre, or link text", () => {
    for (const html of [
      "<p><code>@alpha</code></p>",
      "<pre><code>@alpha</code></pre>",
      '<p><a href="#">@alpha</a></p>',
      '<p><span class="md-math"><span class="katex"><span>hi @alpha</span></span></span></p>',
    ]) {
      expect(injectMentionChips(html, agents), html).toBe(html);
    }
  });

  it("starts a fresh line after a block tag", () => {
    expect(injectMentionChips("<p>hi</p><p>@alpha</p>", agents)).toContain(
      '<p><span class="mention-chip"',
    );
  });

  it("returns the html untouched when there is no roster", () => {
    expect(injectMentionChips("<p>@alpha</p>", [])).toBe("<p>@alpha</p>");
  });

  it("leaves a hash as written", () => {
    expect(injectMentionChips("<p>#출시 올려</p>", agents)).toBe("<p>#출시 올려</p>");
  });
});

describe("mentionRuns", () => {
  it("reads a mentioned id back as the roster name", () => {
    expect(mentionRuns("@gamma 확인해줘", agents)).toEqual([
      { text: "@춘식이", mention: true },
      { text: " 확인해줘", mention: false },
    ]);
  });

  it("keeps trailing punctuation outside the mention", () => {
    expect(mentionRuns("@alpha, 봐줘", agents)).toEqual([
      { text: "@Alpha", mention: true },
      { text: ", 봐줘", mention: false },
    ]);
  });

  it("leaves a hash as written", () => {
    expect(mentionRuns("#ship 에 올렸어", agents)).toEqual([
      { text: "#ship 에 올렸어", mention: false },
    ]);
  });

  it("leaves an unknown handle as written", () => {
    expect(mentionRuns("@nobody 안녕", agents)).toEqual([
      { text: "@nobody 안녕", mention: false },
    ]);
  });

  it("ignores an @ that is not a handle start", () => {
    expect(mentionRuns("mail me@alpha now", agents)).toEqual([
      { text: "mail me@alpha now", mention: false },
    ]);
  });
});

describe("mentionRuns edge cases", () => {
  it("does not swallow a character on a doubled hash", () => {
    expect(mentionRuns("##ship 올려", agents)).toEqual([
      { text: "##ship 올려", mention: false },
    ]);
  });

  it("returns the text whole when there is no roster", () => {
    expect(mentionRuns("@alpha ping", [])).toEqual([
      { text: "@alpha ping", mention: false },
    ]);
    expect(mentionRuns("", agents)).toEqual([]);
  });
});

describe("mentionText", () => {
  it("reads back what the row shows, so a search can match it", () => {
    expect(mentionText("@gamma 확인해줘", agents)).toBe("@춘식이 확인해줘");
    expect(mentionText("#ship 올려", agents)).toBe("#ship 올려");
  });
});
