import { describe, expect, it } from "vitest";
import {
  addBot,
  moveBot,
  removeBot,
  templateBotLine,
  templateFromGroup,
  templateProblem,
  toggleLead,
} from "./templateEdit";
import { emptyTemplate, type Template } from "./templates";
import type { AgentInfo, Group } from "./types";

function named(...names: string[]): Template {
  const t = emptyTemplate();
  return {
    ...t,
    name: "팀",
    bots: names.map((name) => ({ name, role: "", cli: "claude", model: "", tier: "normal", effort: "" })),
  };
}

const names = (t: Template) => t.bots.map((b) => b.name);

describe("editing a template's bots", () => {
  it("keeps the lead on the same bot through a move", () => {
    const t = { ...named("a", "b", "c"), lead: 0 };
    const moved = moveBot(t, 0, 2);
    expect(names(moved)).toEqual(["b", "c", "a"]);
    expect(moved.lead).toBe(2);
    expect(moveBot({ ...t, lead: null }, 0, 1).lead).toBeNull();
  });

  it("drops the lead with its bot and shifts the rest", () => {
    const t = { ...named("a", "b", "c"), lead: 2 };
    expect(removeBot(t, 0).lead).toBe(1);
    expect(removeBot(t, 2).lead).toBeNull();
    expect(names(removeBot(t, 1))).toEqual(["a", "c"]);
  });

  it("has one lead, and the star takes it off again", () => {
    const t = named("a", "b");
    expect(toggleLead(t, 1).lead).toBe(1);
    expect(toggleLead(toggleLead(t, 1), 0).lead).toBe(0);
    expect(toggleLead(toggleLead(t, 1), 1).lead).toBeNull();
  });

  it("adds a bot on the given AI, never on a typed command", () => {
    const t = addBot(named(), "새 봇", { cli: "claude", model: "haiku", effort: "low" }, "star");
    expect(t.bots[0]).toMatchObject({ cli: "claude", model: "haiku", tier: "fast", effort: "low", shape: "star" });
    const custom = addBot(named(), "x", { cli: "custom", model: "", effort: "" }, "star");
    expect(custom.bots[0].cli).toBe("claude");
  });

  it("needs a name for the template and for each bot", () => {
    expect(templateProblem(named("a"))).toBeNull();
    expect(templateProblem({ ...named("a"), name: " " })).toBe("name");
    expect(templateProblem(named("a", " "))).toBe("botName");
  });
});

describe("templateFromGroup", () => {
  const agent = (id: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({
    id,
    name: id.toUpperCase(),
    status: "idle",
    cmd: ["claude"],
    cwd: "",
    routines: [],
    ...extra,
  });
  const group: Group = {
    id: "g",
    name: "Crew",
    collapsed: false,
    items: ["agent:a", "agent:t", "agent:r", "agent:lead"],
    lead: "lead",
    worktree: "off",
  };

  it("keeps the bots' settings, the lead and the memory, and leaves the rest", () => {
    const agents = [
      agent("a", { model: "haiku", effort: "low", role: "리뷰", avatar_shape: "star", avatar_color: "#ff0000" }),
      agent("t", { cmd: ["bash"] }),
      agent("r", { remote: "team" }),
      agent("lead", { cmd: ["/usr/local/bin/grok"], model: null }),
    ];
    const { template, skipped } = templateFromGroup(group, agents, "규칙");
    expect(skipped).toBe(2);
    expect(template.bots).toEqual([
      { name: "A", role: "리뷰", cli: "claude", model: "haiku", tier: "fast", effort: "low", shape: "star" },
      { name: "LEAD", role: "", cli: "grok", model: "", tier: "normal", effort: "", shape: null },
    ]);
    expect(template).toMatchObject({ name: "Crew", lead: 1, memory: "규칙", worktree: false, id: "", builtin: false });
    expect(JSON.stringify(template)).not.toContain("#ff0000");
  });

  it("works in worktrees unless the group turned them off", () => {
    expect(templateFromGroup({ ...group, worktree: undefined }, [], "").template.worktree).toBe(true);
  });
});

describe("templateBotLine", () => {
  const t = ((key: string) => ({ "field.effort": "노력", "effort.high": "꼼꼼하게", "model.default": "기본값" })[key] ?? key) as never;
  it("names the tier's model when the bot has none", () => {
    expect(templateBotLine({ cli: "claude", model: "", tier: "strong", effort: "high" }, t)).toBe("Claude · opus · 노력 꼼꼼하게");
    expect(templateBotLine({ cli: "codex", model: "", tier: "strong", effort: "" }, t)).toBe("Codex · 기본값");
  });
});
