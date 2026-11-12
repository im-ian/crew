import { describe, expect, it } from "vitest";
import { interpolate } from "./i18n";
import { KO } from "./locales";
import { untilLabel, usageClis, usageColumns, usageRows, windowName } from "./planUsage";
import type { AgentInfo } from "./types";

const t = (key: keyof typeof KO, vars?: Record<string, string | number>) => interpolate(KO[key], vars);
const bot = (cmd: string): AgentInfo => ({ id: cmd, name: cmd, status: "idle", cmd: [cmd] }) as AgentInfo;
const NOW = 1_800_000_000_000;
const H5 = 300;
const WEEK = 10080;
const w = (usedPercent: number, minutes: number | null, resetsAt?: number) => ({ usedPercent, minutes, resetsAt });

describe("plan usage", () => {
  it("asks only about the CLIs of the bots there are", () => {
    expect(usageClis([bot("/usr/local/bin/grok"), bot("gemini"), bot("grok")])).toEqual(["grok"]);
    expect(usageClis([bot("grok"), bot("claude")])).toEqual(["claude", "grok"]);
  });

  it("shows both Claude windows, with the reset in the title", () => {
    const rows = usageRows(
      [{ cli: "claude", windows: [w(37.4, H5, NOW / 1000 + 2 * 3600), w(30, WEEK)] }],
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
    const rows = usageRows([{ cli: "claude", windows: [w(92, WEEK)] }], NOW, t);
    expect(rows[0].cells.map((c) => c.key)).toEqual(["10080"]);
    expect(rows[0].cells[0].warn).toBe(true);
  });

  it("does not show a number from before the window started over", () => {
    const rows = usageRows([{ cli: "grok", windows: [w(99, WEEK, NOW / 1000 - 60)] }], NOW, t);
    expect(rows[0].cells[0]).toMatchObject({ stale: true, warn: false });
    expect(rows[0].cells[0].title).toBe("Grok 주간 한도가 초기화됐어요. 다음 사용 때 새 값을 읽어요");
  });

  it("keeps only the weekly column when no plan has a five-hour cap", () => {
    const none = usageRows(
      [
        { cli: "claude", windows: [w(40, WEEK)] },
        { cli: "grok", windows: [w(10, WEEK)] },
      ],
      NOW,
      t,
    );
    expect(usageColumns(none).map((c) => c.label)).toEqual(["주간"]);
    const some = usageRows(
      [
        { cli: "claude", windows: [w(5, H5), w(40, WEEK)] },
        { cli: "grok", windows: [w(10, WEEK)] },
      ],
      NOW,
      t,
    );
    expect(usageColumns(some).map((c) => c.label)).toEqual(["5h", "주간"]);
  });

  it("gives each window length a column, shortest first, named for its length", () => {
    const rows = usageRows(
      [
        { cli: "claude", windows: [w(5, H5), w(40, WEEK)] },
        { cli: "codex", windows: [w(41, 43200, NOW / 1000 + 9 * 86400)] },
        { cli: "grok", windows: [w(3, 1440), w(20, 20160)] },
      ],
      NOW,
      t,
    );
    expect(usageColumns(rows).map((c) => c.label)).toEqual(["5h", "1일", "주간", "14일", "30일"]);
    const codex = rows.find((r) => r.cli === "codex")!;
    expect(codex.cells).toMatchObject([{ key: "43200", percent: 41, name: "30일 한도" }]);
    expect(codex.cells[0].title).toContain("30일 한도");
  });

  it("names a window for its length, and one of unknown length plainly", () => {
    expect(windowName(300, t)).toBe("5h");
    expect(windowName(300, t, true)).toBe("5시간 한도");
    expect(windowName(10080, t)).toBe("주간");
    expect(windowName(43200, t, true)).toBe("30일 한도");
    expect(windowName(90, t)).toBe("2h");
    expect(windowName(null, t)).toBe("한도");
  });

  it("lists Codex and Antigravity too, in a fixed order", () => {
    expect(usageClis([bot("agy"), bot("codex"), bot("grok"), bot("claude")])).toEqual(["claude", "codex", "grok", "agy"]);
  });

  it("keeps each Antigravity model pool for the details", () => {
    const rows = usageRows(
      [
        {
          cli: "agy",
          windows: [w(25, WEEK)],
          groups: [
            { name: "Gemini Models", window: w(25, WEEK) },
            { name: "Claude and GPT models", window: w(0, WEEK) },
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
    expect(usageRows([{ cli: "grok", windows: [] }], NOW, t)).toEqual([]);
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
