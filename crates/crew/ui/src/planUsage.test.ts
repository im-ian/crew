import { describe, expect, it } from "vitest";
import { interpolate } from "./i18n";
import { KO } from "./locales";
import { untilLabel, usageClis, usageColumns, usageRows } from "./planUsage";
import type { AgentInfo } from "./types";

const t = (key: keyof typeof KO, vars?: Record<string, string | number>) => interpolate(KO[key], vars);
const bot = (cmd: string): AgentInfo => ({ id: cmd, name: cmd, status: "idle", cmd: [cmd] }) as AgentInfo;
const NOW = 1_800_000_000_000;

describe("plan usage", () => {
  it("asks only about the CLIs of the bots there are", () => {
    expect(usageClis([bot("/usr/local/bin/grok"), bot("gemini"), bot("grok")])).toEqual(["grok"]);
    expect(usageClis([bot("grok"), bot("claude")])).toEqual(["claude", "grok"]);
  });

  it("shows both Claude windows, with the reset in the title", () => {
    const rows = usageRows(
      [{ cli: "claude", fiveHour: { usedPercent: 37.4, resetsAt: NOW / 1000 + 2 * 3600 }, weekly: { usedPercent: 30 } }],
      NOW,
      t,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cells.map((c) => [c.label, c.percent])).toEqual([
      ["5h", 37],
      ["주간", 30],
    ]);
    expect(rows[0].cells[0].title).toBe("Claude 5시간 한도 37% 사용 · 2시간 뒤 초기화");
  });

  it("drops the five-hour window while the plan has none", () => {
    const rows = usageRows([{ cli: "claude", fiveHour: null, weekly: { usedPercent: 92 } }], NOW, t);
    expect(rows[0].cells.map((c) => c.key)).toEqual(["weekly"]);
    expect(rows[0].cells[0].warn).toBe(true);
  });

  it("does not show a number from before the window started over", () => {
    const rows = usageRows([{ cli: "grok", weekly: { usedPercent: 99, resetsAt: NOW / 1000 - 60 } }], NOW, t);
    expect(rows[0].cells[0]).toMatchObject({ stale: true, warn: false });
    expect(rows[0].cells[0].title).toBe("Grok 주간 한도가 초기화됐어요. 다음 사용 때 새 값을 읽어요");
  });

  it("keeps only the weekly column when no plan has a five-hour cap", () => {
    const none = usageRows(
      [
        { cli: "claude", fiveHour: null, weekly: { usedPercent: 40 } },
        { cli: "grok", weekly: { usedPercent: 10 } },
      ],
      NOW,
      t,
    );
    expect(usageColumns(none).map((c) => c.label)).toEqual(["주간"]);
    const some = usageRows(
      [
        { cli: "claude", fiveHour: { usedPercent: 5 }, weekly: { usedPercent: 40 } },
        { cli: "grok", weekly: { usedPercent: 10 } },
      ],
      NOW,
      t,
    );
    expect(usageColumns(some).map((c) => c.label)).toEqual(["5h", "주간"]);
  });

  it("lists Codex and Antigravity too, in a fixed order", () => {
    expect(usageClis([bot("agy"), bot("codex"), bot("grok"), bot("claude")])).toEqual(["claude", "codex", "grok", "agy"]);
  });

  it("keeps each Antigravity model pool for the details", () => {
    const rows = usageRows(
      [
        {
          cli: "agy",
          weekly: { usedPercent: 25 },
          groups: [
            { name: "Gemini Models", window: { usedPercent: 25 } },
            { name: "Claude and GPT models", window: { usedPercent: 0 } },
          ],
        },
      ],
      NOW,
      t,
    );
    expect(rows[0].label).toBe("Antigravity");
    expect(rows[0].cells.map((c) => c.percent)).toEqual([25]);
    expect(rows[0].groups.map((g) => [g.name, g.cell.percent])).toEqual([
      ["Gemini Models", 25],
      ["Claude and GPT models", 0],
    ]);
  });

  it("leaves out a CLI with no window", () => {
    expect(usageRows([{ cli: "grok", fiveHour: null, weekly: null }], NOW, t)).toEqual([]);
  });

  it("counts down in the shortest unit that is not zero", () => {
    expect(untilLabel(NOW / 1000 + 30, NOW, t)).toBe("1분 뒤");
    expect(untilLabel(NOW / 1000 + 3 * 86400, NOW, t)).toBe("3일 뒤");
    expect(untilLabel(null, NOW, t)).toBeNull();
  });
});

describe("plan usage popover", () => {
  it("opens above the button with the same left edge", async () => {
    const { popoverPlace } = await import("./components/PlanUsageBar");
    const rect = { left: 44, top: 700 } as DOMRect;
    expect(popoverPlace(rect, 760)).toEqual({ left: 44, bottom: 66 });
  });
});
