import { describe, expect, it } from "vitest";
import {
  TIER_MODELS,
  copyTemplate,
  exhaustedClis,
  resolveBot,
  tierModel,
  tierOf,
  type Template,
} from "./templates";

const CODEX = ["gpt-reserve", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"];
const GROK = ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"];

describe("tier models", () => {
  it("has every tier for every CLI Crew knows", () => {
    for (const [cli, tiers] of Object.entries(TIER_MODELS)) {
      for (const tier of ["strong", "normal", "fast"] as const) {
        expect(tiers[tier].length, `${cli} ${tier}`).toBeGreaterThan(0);
        // The last resort is always there: a name to try, or the default.
        const last = tiers[tier][tiers[tier].length - 1];
        expect(typeof last, `${cli} ${tier}`).toBe("string");
      }
    }
  });

  it("takes Claude's aliases", () => {
    const list = { models: ["sonnet", "opus", "haiku", "fable"] };
    expect(tierModel("claude", "strong", list)).toBe("opus");
    expect(tierModel("claude", "normal", list)).toBe("sonnet");
    expect(tierModel("claude", "fast", list)).toBe("haiku");
    expect(tierModel("claude", "strong")).toBe("opus");
  });

  it("finds a light model by name, and the default otherwise", () => {
    expect(tierModel("codex", "fast", { models: CODEX })).toBe("gpt-6-luna");
    expect(tierModel("codex", "strong", { models: CODEX })).toBe("");
    expect(tierModel("grok", "fast", { models: GROK })).toBe("grok-4.7-build-fast");
    expect(tierModel("grok", "fast", { models: ["grok-4.7"] })).toBe("");
    expect(tierModel("gemini", "strong")).toBe("");
    expect(tierModel("custom", "strong")).toBe("");
  });

  it("reads a tier back from a model", () => {
    expect(tierOf("claude", "opus")).toBe("strong");
    expect(tierOf("claude", "haiku")).toBe("fast");
    expect(tierOf("grok", "grok-4.7-build-fast")).toBe("fast");
    expect(tierOf("codex", "")).toBe("normal");
    expect(tierOf("codex", "gpt-5.6-terra")).toBe("normal");
  });
});

describe("resolveBot", () => {
  const strong = { cli: "claude", model: "", tier: "strong" as const, effort: "high" };

  it("keeps the template's CLI when it can run", () => {
    const r = resolveBot(strong, { claude: { installed: true } });
    expect(r).toEqual({ cli: "claude", model: "opus", effort: "high" });
    const own = resolveBot({ ...strong, model: "sonnet" }, { claude: { installed: true } });
    expect(own.model).toBe("sonnet");
  });

  it("stands in a CLI that is here, at the same tier and effort", () => {
    const r = resolveBot(strong, {
      claude: { installed: false },
      codex: { installed: true, models: CODEX },
    });
    expect(r).toEqual({ cli: "codex", model: "", effort: "high", from: "claude", reason: "missing" });
    const fast = resolveBot({ ...strong, tier: "fast" }, {
      codex: { installed: true, models: CODEX },
    });
    expect(fast.model).toBe("gpt-6-luna");
  });

  it("follows the user's AI order first", () => {
    const states = {
      grok: { installed: true, models: GROK },
      codex: { installed: true, models: CODEX },
    };
    expect(resolveBot(strong, states, ["codex", "grok"]).cli).toBe("codex");
    expect(resolveBot(strong, states, []).cli).toBe("grok");
  });

  it("steps off a CLI that is out of its limit", () => {
    const r = resolveBot(strong, {
      claude: { installed: true, exhausted: true },
      grok: { installed: true, models: GROK },
    });
    expect(r.cli).toBe("grok");
    expect(r.reason).toBe("exhausted");
  });

  it("drops the effort on a CLI that has none", () => {
    const r = resolveBot(strong, { gemini: { installed: true } });
    expect(r).toMatchObject({ cli: "gemini", effort: "", from: "claude" });
  });

  it("stays put, saying why, when nothing can run", () => {
    const r = resolveBot(strong, {});
    expect(r).toEqual({ cli: "claude", model: "", effort: "high", reason: "missing" });
  });
});

describe("exhaustedClis", () => {
  it("counts a full window that has not reset, and not Antigravity's pools", () => {
    const now = 1000;
    const out = exhaustedClis(
      [
        { cli: "claude", windows: [{ usedPercent: 100, resetsAt: 2000 }] },
        { cli: "codex", windows: [{ usedPercent: 100, resetsAt: 500 }] },
        { cli: "grok", windows: [{ usedPercent: 80, resetsAt: 2000 }] },
        { cli: "agy", windows: [{ usedPercent: 100, resetsAt: 2000 }] },
      ],
      now,
    );
    expect([...out]).toEqual(["claude"]);
  });
});

describe("copyTemplate", () => {
  it("makes Crew's template the user's own", () => {
    const t: Template = {
      id: "crew-dev",
      name: "개발 팀",
      description: "",
      bots: [{ name: "a", role: "", cli: "claude", model: "", tier: "strong", effort: "", shape: "star" }],
      lead: 0,
      memory: "m",
      worktree: true,
      builtin: true,
    };
    const c = copyTemplate(t, "개발 팀 (내 버전)");
    expect(c).toMatchObject({ id: "", name: "개발 팀 (내 버전)", builtin: false, lead: 0 });
    c.bots[0].name = "b";
    expect(t.bots[0].name).toBe("a");
  });
});
