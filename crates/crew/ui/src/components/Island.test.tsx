import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { translate } from "../i18n";
import type { IslandNotice } from "../island";
import type { AgentInfo } from "../types";
import { goFromPile, Island, IslandPile } from "./Island";

// The app's provider reads the laptop's settings, which a server render has not got.
vi.mock("../LocaleContext", () => {
  const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
    translate("ko", key, vars);
  return { useLocale: () => ({ locale: "ko", t }), useT: () => t };
});

const bot = (id: string, name: string): AgentInfo =>
  ({ id, name, status: "idle", cmd: [], cwd: "", routines: [] }) as unknown as AgentInfo;
const agents = [bot("arch", "설계자"), bot("dbg", "디버거"), bot("dev", "개발자")];
const about = (seq: number, botId: string, kind: IslandNotice["kind"]): IslandNotice =>
  ({ seq, stays: true, piled: true, kind, botId }) as IslandNotice;

function pile(notices: IslandNotice[], open = false) {
  return renderToStaticMarkup(
    <IslandPile
      notices={notices}
      agents={agents}
      onOpenBot={() => {}}
      open={open}
      onToggle={() => {}}
      onClear={() => {}}
    />,
  );
}

describe("IslandPile", () => {
  it("shows the most pressing notice, how many more, and its Go", () => {
    const html = pile([about(3, "dev", "success"), about(2, "arch", "question"), about(1, "dbg", "blocked")]);
    expect(html).toContain("설계자가");
    expect(html).toMatch(/island-more[^>]*>외 2개</);
    expect(html).toContain("island-go");
  });

  it("shows a pile of one as that notice, with no count", () => {
    const html = pile([about(1, "dev", "success")]);
    expect(html).not.toContain("island-more");
    expect(html).toContain("island-go");
  });
});

describe("IslandPile laid out", () => {
  it("says how many it holds, so the list under it shows nothing twice", () => {
    const html = pile(
      [about(3, "dev", "success"), about(2, "arch", "question"), about(1, "dbg", "blocked")],
      true,
    );
    expect(html).toContain("알림 3개");
    expect(html).not.toContain("island-more");
    expect(html).not.toContain("island-go");
    expect(html).not.toContain("설계자가");
  });
});

describe("Island pile", () => {
  it("leaves an app phrase out, including one already folded in", () => {
    const err: IslandNotice = {
      seq: 1,
      stays: true,
      piled: true,
      kind: "error",
      text: "이름을 입력하세요",
    };
    const html = renderToStaticMarkup(
      <Island
        notices={[err, about(2, "arch", "question")]}
        agents={agents}
        onOpenBot={() => {}}
        onClose={() => {}}
        onClearPile={() => {}}
        onHold={() => {}}
        onRelease={() => {}}
      />,
    );
    expect(html).not.toContain("이름을 입력하세요");
    expect(html).toContain("설계자가");
    expect(html).not.toContain("island-more");
  });
});

describe("goFromPile", () => {
  it("opens the bot without laying the pile out", () => {
    const stop = vi.fn();
    const open = vi.fn();
    goFromPile({ stopPropagation: stop }, "arch", open);
    expect(stop).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("arch");
  });
});
