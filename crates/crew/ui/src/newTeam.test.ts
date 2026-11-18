import { describe, expect, it } from "vitest";
import { refill, stepTemplate, swapLine, teamOf, templateOrder, NO_TEMPLATE } from "./newTeam";
import type { Template } from "./templates";

function tpl(id: string, builtin: boolean, extra: Partial<Template> = {}): Template {
  return { id, name: id, description: "", bots: [], lead: null, memory: "", worktree: true, builtin, ...extra };
}

const t = ((key: string, vars?: Record<string, string>) => {
  const text: Record<string, string> = {
    "newGroup.swap.missing": "{cli} 없음",
    "newGroup.swap.limit": "{cli} 한도",
    "newGroup.swap.none": "{why} · 쓸 수 있는 AI가 없어요",
  };
  let out = text[key] ?? key;
  for (const [k, v] of Object.entries(vars ?? {})) out = out.replace(`{${k}}`, v);
  return out;
}) as never;

describe("the template Select", () => {
  const list = [tpl("mine", false), tpl("crew-dev", true), tpl("crew-ops", true)];

  it("lists no template, then Crew's, then the user's", () => {
    expect(templateOrder(list)).toEqual([NO_TEMPLATE, "crew-dev", "crew-ops", "mine"]);
  });

  it("moves with the arrows and stops at the ends", () => {
    const order = templateOrder(list);
    expect(stepTemplate(order, NO_TEMPLATE, 1)).toBe("crew-dev");
    expect(stepTemplate(order, "mine", 1)).toBe("mine");
    expect(stepTemplate(order, NO_TEMPLATE, -1)).toBe(NO_TEMPLATE);
    expect(stepTemplate(order, "gone", 1)).toBe("crew-dev");
  });
});

describe("teamOf", () => {
  const dev = tpl("crew-dev", true, {
    lead: 0,
    bots: [
      { name: "설계자", role: "나눠 맡겨요", cli: "claude", model: "", tier: "strong", effort: "high", shape: "crown" },
      { name: "주니어", role: "", cli: "grok", model: "", tier: "normal", effort: "medium", shape: "cookie" },
    ],
  });

  it("stands in an AI that is here, and says so", () => {
    const team = teamOf(dev, { codex: { installed: true }, grok: { installed: true } }, ["codex"], {});
    expect(team[0]).toMatchObject({ name: "설계자", lead: true, shape: "crown", picked: false });
    expect(team[0].ai).toMatchObject({ cli: "codex", from: "claude", effort: "high" });
    expect(swapLine(team[0], t)).toBe("Claude 없음 → Codex");
    expect(team[1].ai.cli).toBe("grok");
    expect(swapLine(team[1], t)).toBeNull();
  });

  it("names the stand-in's model and a used-up limit", () => {
    const team = teamOf(dev, { claude: { installed: true, exhausted: true }, grok: { installed: true } }, ["grok"], {});
    expect(swapLine(team[0], t)).toBe("Claude 한도 → Grok");
    const fast = teamOf(
      { ...dev, bots: [{ ...dev.bots[0], tier: "fast" }] },
      { codex: { installed: true, models: ["gpt-6-luna"] } },
      [],
      {},
    );
    expect(swapLine(fast[0], t)).toBe("Claude 없음 → Codex gpt-6-luna");
  });

  it("says when nothing can stand in", () => {
    expect(swapLine(teamOf(dev, {}, [], {})[0], t)).toBe("Claude 없음 · 쓸 수 있는 AI가 없어요");
  });

  it("keeps the user's own pick and says nothing of it", () => {
    const team = teamOf(dev, {}, [], { 0: { cli: "codex", model: "gpt-5.6-terra", effort: "low" } });
    expect(team[0].ai).toEqual({ cli: "codex", model: "gpt-5.6-terra", effort: "low" });
    expect(team[0].picked).toBe(true);
    expect(swapLine(team[0], t)).toBeNull();
  });

  it("is empty with no template", () => {
    expect(teamOf(null, {}, [], {})).toEqual([]);
  });
});

describe("refill", () => {
  const ops = tpl("crew-ops", true, { memory: "근거를 붙인다", worktree: false });
  const blank = { memory: "", worktree: true, memoryEdited: false, worktreeEdited: false };

  it("fills the group memory and worktree from the template", () => {
    expect(refill(blank, ops)).toMatchObject({ memory: "근거를 붙인다", worktree: false });
    expect(refill(refill(blank, ops), null)).toMatchObject({ memory: "", worktree: true });
  });

  it("keeps what the user typed over", () => {
    const typed = { ...blank, memory: "내 규칙", memoryEdited: true };
    expect(refill(typed, ops)).toMatchObject({ memory: "내 규칙", worktree: false });
    const set = { ...blank, worktree: true, worktreeEdited: true };
    expect(refill(set, ops).worktree).toBe(true);
  });
});
