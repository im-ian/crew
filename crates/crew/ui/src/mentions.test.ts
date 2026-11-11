import { describe, expect, it } from "vitest";
import {
  groupCandidates,
  injectMentionChips,
  isSelfMentionDelivery,
  mentionIds,
  mentionLabel,
  mentionMatches,
  mentionsId,
  mentionRuns,
  mentionText,
  resolveGroup,
  resolveMention,
  sameMentionAgents,
  trimMentionPunct,
} from "./mentions";
import type { AgentInfo, Group } from "./types";
import { renderMarkdown } from "./markdown";

function agent(id: string, name: string): AgentInfo {
  return { id, name, status: "idle", cmd: ["cat"], cwd: "/tmp", routines: [] };
}

const agents = [agent("alpha", "Alpha"), agent("gamma", "춘식이")];

describe("sameMentionAgents", () => {
  it("ignores what a chip does not draw", () => {
    const next = agents.map((a) => ({ ...a, status: "working" as const, preview: "…", last_ts: 9 }));
    expect(sameMentionAgents(agents, next)).toBe(true);
  });

  it("sees a rename, a new face, or a bot more", () => {
    expect(sameMentionAgents(agents, [{ ...agents[0], name: "Al" }, agents[1]])).toBe(false);
    expect(sameMentionAgents(agents, [{ ...agents[0], avatar_shape: "cat" }, agents[1]])).toBe(false);
    expect(sameMentionAgents(agents, [...agents, agent("beta", "Beta")])).toBe(false);
  });
});

describe("resolveMention", () => {
  it("matches an id or a display name, either case", () => {
    expect(resolveMention("alpha", agents)?.id).toBe("alpha");
    expect(resolveMention("ALPHA", agents)?.id).toBe("alpha");
    expect(resolveMention("춘식이", agents)?.id).toBe("gamma");
    expect(resolveMention("nobody", agents)).toBeUndefined();
  });
});

describe("mentionIds", () => {
  it("sends a typed name as its id and leaves the rest alone", () => {
    expect(mentionIds("@춘식이, @Alpha 봐줘 @nobody mail@alpha", agents)).toBe(
      "@gamma, @alpha 봐줘 @nobody mail@alpha",
    );
  });

  it("keeps a picked chip's id over a name that spells it", () => {
    const clash = [agent("bot-1", "codex"), agent("codex", "Codex")];
    expect(mentionIds("@codex 봐줘", clash)).toBe("@codex 봐줘");
  });

  it("leaves code as written", () => {
    expect(mentionIds("`@춘식이` @춘식이\n```\n@춘식이\n```\n~~~\n@춘식이", agents)).toBe(
      "`@춘식이` @gamma\n```\n@춘식이\n```\n~~~\n@춘식이",
    );
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

  it("ends an id where a Korean particle starts", () => {
    expect(injectMentionChips("<p>@gamma에게 전했어</p>", agents)).toBe(
      '<p><span class="mention-chip" data-mention="gamma"></span>에게 전했어</p>',
    );
  });

  it("needs the id to end the word", () => {
    for (const html of ["<p>@alpha.ai</p>", "<p>@alpha/cli</p>", "<p>@alpha's</p>"]) {
      expect(injectMentionChips(html, agents), html).toBe(html);
    }
    expect(injectMentionChips("<p>@alpha: 봐줘</p>", agents)).toContain(
      '"alpha"></span>: 봐줘',
    );
  });

  it("leaves a name as written, since only ids are stored", () => {
    expect(injectMentionChips("<p>@춘식이 봐줘</p>", agents)).toBe("<p>@춘식이 봐줘</p>");
  });

  it("ignores an @ glued to the end of a word", () => {
    expect(injectMentionChips("<p>mail@alpha</p>", agents)).toBe("<p>mail@alpha</p>");
  });

  it("reads a handle right after an opening bracket or quote", () => {
    const chip = '<span class="mention-chip" data-mention="alpha"></span>';
    // The case that showed up: an id, a closing bracket, then a particle.
    expect(injectMentionChips("<p>UI/UX @alpha)끼리만</p>", agents)).toBe(
      `<p>UI/UX ${chip})끼리만</p>`,
    );
    expect(injectMentionChips("<p>개발자(@alpha)끼리</p>", agents)).toBe(`<p>개발자(${chip})끼리</p>`);
    expect(injectMentionChips("<p>[@alpha]</p>", agents)).toBe(`<p>[${chip}]</p>`);
    expect(injectMentionChips("<p>「@alpha」</p>", agents)).toBe(`<p>「${chip}」</p>`);
    expect(injectMentionChips("<p>'@alpha'</p>", agents)).toBe(`<p>'${chip}'</p>`);
    // Markdown escapes a quote before the page sees it.
    expect(injectMentionChips("<p>&quot;@alpha&quot;</p>", agents)).toBe(
      `<p>&quot;${chip}&quot;</p>`,
    );
    // Through the real renderer: quotes, brackets, a particle after ")".
    const rendered = injectMentionChips(
      renderMarkdown('"@alpha" 그리고 (@gamma)끼리, 「@alpha」'),
      agents,
    );
    expect(rendered.match(/mention-chip/g)?.length).toBe(3);
    expect(injectMentionChips(renderMarkdown("`(@alpha)`"), agents)).not.toContain("mention-chip");
    // Any other entity, or a letter, still glues the @ to a word, and a
    // domain or a possessive still goes on past the id.
    for (const html of ["<p>&amp;@alpha</p>", "<p>x(y@alpha)</p>", "<p>(@alpha.ai)</p>", "<p>(@alpha's)</p>"]) {
      expect(injectMentionChips(html, agents), html).toBe(html);
    }
  });

  it("reads a bracketed handle the same in previews, sends and self-copies", () => {
    expect(mentionRuns("개발자(@alpha)", agents).map((r) => r.agent?.id ?? r.text)).toEqual([
      "개발자(",
      "alpha",
      ")",
    ]);
    expect(mentionIds("기획자(@Alpha) 봐줘", agents)).toBe("기획자(@alpha) 봐줘");
    // A name closed by a bracket and a particle is still the bot.
    expect(mentionIds("개발자(@춘식이)끼리 봐줘", agents)).toBe("개발자(@gamma)끼리 봐줘");
    expect(mentionIds("(@Alpha.ai) 봐", agents)).toBe("(@Alpha.ai) 봐");
    expect(mentionIds("`(@Alpha)`", agents)).toBe("`(@Alpha)`");
    expect(mentionsId("디자이너(@gamma)", "gamma")).toBe(true);
    expect(mentionsId("mail@gamma", "gamma")).toBe(false);
    // Raw text keeps a quote as itself, as the daemon reads it.
    expect(mentionsId("ping @gamma&quot;", "gamma")).toBe(false);
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
      { text: "@춘식이", agent: agents[1] },
      { text: " 확인해줘" },
    ]);
  });

  it("keeps trailing punctuation outside the mention", () => {
    expect(mentionRuns("@alpha, 봐줘", agents)).toEqual([
      { text: "@Alpha", agent: agents[0] },
      { text: ", 봐줘" },
    ]);
  });

  it("leaves a hash as written", () => {
    expect(mentionRuns("#ship 에 올렸어", agents)).toEqual([
      { text: "#ship 에 올렸어" },
    ]);
  });

  it("leaves an unknown handle as written", () => {
    expect(mentionRuns("@nobody 안녕", agents)).toEqual([
      { text: "@nobody 안녕" },
    ]);
  });

  it("ignores an @ that is not a handle start", () => {
    expect(mentionRuns("mail me@alpha now", agents)).toEqual([
      { text: "mail me@alpha now" },
    ]);
  });
});

describe("mentionRuns edge cases", () => {
  it("does not swallow a character on a doubled hash", () => {
    expect(mentionRuns("##ship 올려", agents)).toEqual([
      { text: "##ship 올려" },
    ]);
  });

  it("returns the text whole when there is no roster", () => {
    expect(mentionRuns("@alpha ping", [])).toEqual([
      { text: "@alpha ping" },
    ]);
    expect(mentionRuns("", agents)).toEqual([]);
  });
});

describe("a mention delivered into the named bot's chat", () => {
  const copy = {
    role: "system",
    from: "user",
    kind: "received" as const,
    text: "@grok-project 에게 물어봐서 바꿔줘",
  };

  it("is the received copy that names this bot", () => {
    expect(mentionsId(copy.text, "grok-project")).toBe(true);
    expect(mentionsId("@grok-project, 다음", "grok-project")).toBe(true);
    expect(mentionsId("mail@grok-project now", "grok-project")).toBe(false);
    expect(mentionsId("@grok-project-2 hi", "grok-project")).toBe(false);
    expect(mentionsId("@grok-project.ai 봐", "grok-project")).toBe(false);
    expect(mentionsId("@grok-project/cli 봐", "grok-project")).toBe(false);
    expect(mentionsId("@grok-project's 봐", "grok-project")).toBe(false);
    expect(isSelfMentionDelivery(copy, "grok-project")).toBe(true);
  });

  it("stays in the chat where it was typed", () => {
    expect(
      isSelfMentionDelivery(
        { role: "user", from: "user", text: copy.text },
        "grok-project",
      ),
    ).toBe(false);
    expect(isSelfMentionDelivery(copy, "someone-else")).toBe(false);
    expect(isSelfMentionDelivery({ ...copy, from: "alpha" }, "grok-project")).toBe(false);
    expect(isSelfMentionDelivery(copy, null)).toBe(false);
  });
});

describe("mentionText", () => {
  it("reads back what the row shows, so a search can match it", () => {
    expect(mentionText("@gamma 확인해줘", agents)).toBe("@춘식이 확인해줘");
    expect(mentionText("#ship 올려", agents)).toBe("#ship 올려");
  });
});

describe("a remote bot's handle", () => {
  const amy: AgentInfo = {
    ...agent("team/acc_k3j9", "amy"),
    cmd: [],
    cwd: "",
    remote: "team",
    remote_online: true,
  };
  const roster = [...agents, amy];

  it("reads alias/account as one id and shows server and name", () => {
    expect(mentionLabel(amy)).toBe("team · amy");
    expect(mentionRuns("@team/acc_k3j9 봐줘", roster)).toEqual([
      { text: "@team · amy", agent: amy },
      { text: " 봐줘" },
    ]);
    expect(injectMentionChips("<p>@team/acc_k3j9에게 물어봐</p>", roster)).toBe(
      '<p><span class="mention-chip" data-mention="team/acc_k3j9"></span>에게 물어봐</p>',
    );
  });

  it("needs the whole id to end the word", () => {
    expect(mentionRuns("@team/acc_k3j9x 봐", roster)).toEqual([
      { text: "@team/acc_k3j9x 봐" },
    ]);
    expect(mentionRuns("@team/acc_k3j9/x 봐", roster)).toEqual([
      { text: "@team/acc_k3j9/x 봐" },
    ]);
  });

  it("sends alias/name typed by hand as the id", () => {
    expect(mentionIds("@team/amy 확인해줘", roster)).toBe("@team/acc_k3j9 확인해줘");
    expect(mentionIds("@amy 확인해줘", roster)).toBe("@team/acc_k3j9 확인해줘");
  });

  it("is found by its server or its own name", () => {
    const found = (q: string) => roster.filter((a) => mentionMatches(a, q)).map((a) => a.id);
    expect(found("tea")).toEqual(["team/acc_k3j9"]);
    expect(found("AM")).toContain("team/acc_k3j9");
    expect(found("team/amy")).toEqual(["team/acc_k3j9"]);
    expect(found("")).toHaveLength(roster.length);
    expect(found("nobody")).toEqual([]);
  });

  it("finds a delivered copy that names the remote id", () => {
    expect(mentionsId("@team/acc_k3j9 hi", "team/acc_k3j9")).toBe(true);
    expect(mentionsId("@team/acc_k3j9 hi", "team")).toBe(false);
  });
});

describe("a #group handle", () => {
  const groups: Group[] = [
    { id: "g19a3", name: "Crew", collapsed: false, items: ["agent:alpha"] },
    { id: "__ungrouped", name: "", collapsed: false, items: [] },
  ];

  it("reads a group id back as the group's name", () => {
    expect(mentionRuns("#g19a3에서 해줘", agents, groups)).toEqual([
      { text: "#Crew", group: groups[0] },
      { text: "에서 해줘" },
    ]);
    expect(mentionText("@alpha #g19a3, 봐줘", agents, groups)).toBe("@Alpha #Crew, 봐줘");
  });

  it("leaves a number, a heading, or a name as written", () => {
    expect(mentionRuns("#233 머지됨", agents, groups)).toEqual([{ text: "#233 머지됨" }]);
    expect(mentionRuns("#Crew 봐줘", agents, groups)).toEqual([{ text: "#Crew 봐줘" }]);
    expect(mentionRuns("#__ungrouped", agents, groups)).toEqual([{ text: "#__ungrouped" }]);
    expect(mentionRuns("issue#g19a3", agents, groups)).toEqual([{ text: "issue#g19a3" }]);
  });

  it("turns into a chip that carries the group's name", () => {
    expect(injectMentionChips("<p>#g19a3 봐줘</p>", [], groups)).toBe(
      '<p><span class="mention-chip" data-group="g19a3" data-label="Crew"></span> 봐줘</p>',
    );
  });

  it("is sent as its id when typed by name", () => {
    expect(mentionIds("#crew 에서 @Alpha 불러줘 #233", agents, groups)).toBe(
      "#g19a3 에서 @alpha 불러줘 #233",
    );
    expect(mentionIds("`#Crew`", agents, groups)).toBe("`#Crew`");
  });

  it("offers the named groups only", () => {
    expect(groupCandidates(groups, "").map((g) => g.id)).toEqual(["g19a3"]);
    expect(groupCandidates(groups, "cr").map((g) => g.id)).toEqual(["g19a3"]);
    expect(resolveGroup("CREW", groups)?.id).toBe("g19a3");
  });
});
