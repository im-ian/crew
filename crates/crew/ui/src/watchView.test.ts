import { describe, expect, it } from "vitest";
import { translate } from "./i18n";
import type { AgentInfo } from "./types";
import { isWatching, watchLabel } from "./watchView";

const ko = (
  key: Parameters<typeof translate>[1],
  vars?: Record<string, string | number>,
) => translate("ko", key, vars);

function bot(over: Partial<AgentInfo>): AgentInfo {
  return {
    id: "b",
    name: "b",
    status: "working",
    cmd: [],
    cwd: "",
    routines: [],
    ...over,
  };
}

describe("isWatching", () => {
  it("is a working bot with background work left", () => {
    expect(isWatching(bot({ watch: [{ what: "CI", since: 0 }] }))).toBe(true);
    expect(isWatching(bot({}))).toBe(false);
    expect(
      isWatching(bot({ status: "idle", watch: [{ what: "CI", since: 0 }] })),
    ).toBe(false);
    expect(isWatching(null)).toBe(false);
  });
});

describe("watchLabel", () => {
  it("says what it watches and for how many minutes", () => {
    const b = bot({ watch: [{ what: "Watch PR 12 CI", since: 0 }] });
    expect(watchLabel(b, 30_000, ko)).toBe("감시 중 · Watch PR 12 CI");
    expect(watchLabel(b, 12 * 60_000 + 5_000, ko)).toBe(
      "감시 중 · 12분째 · Watch PR 12 CI",
    );
  });

  it("counts from the oldest task and names them all", () => {
    const b = bot({
      watch: [
        { what: "deploy", since: 60_000 },
        { what: "CI", since: 0 },
        { what: " ", since: 0 },
      ],
    });
    expect(watchLabel(b, 3 * 60_000, ko)).toBe("감시 중 · 3분째 · deploy, CI");
  });
});
