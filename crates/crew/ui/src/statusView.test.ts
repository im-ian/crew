import { describe, expect, it } from "vitest";
import { translate } from "./i18n";
import { briefStatus, statusView } from "./statusView";
import type { AgentInfo } from "./types";

const ko = (
  key: Parameters<typeof translate>[1],
  vars?: Record<string, string | number>,
) => translate("ko", key, vars);

function bot(over: Partial<AgentInfo> = {}): AgentInfo {
  return { id: "b", name: "b", status: "idle", cmd: [], cwd: "", routines: [], ...over };
}

const NOW = 1_000_000_000;

describe("statusView", () => {
  it("says nothing for an idle bot or none", () => {
    expect(statusView(bot(), NOW, ko)).toBeNull();
    expect(statusView(null, NOW, ko)).toBeNull();
  });

  it("names working, blocked and exited", () => {
    expect(statusView(bot({ status: "working" }), NOW, ko)).toEqual({ tone: "working", text: "작업 중" });
    expect(statusView(bot({ status: "blocked" }), NOW, ko)).toEqual({ tone: "blocked", text: "확인 필요" });
    expect(statusView(bot({ status: "exited" }), NOW, ko)).toEqual({ tone: "exited", text: "종료됨" });
  });

  it("names what a watch watches, and how long", () => {
    const watching = bot({ watch: [{ what: "CI", since: NOW - 3 * 60_000 }] });
    expect(statusView(watching, NOW, ko)).toEqual({ tone: "watching", text: "감시 중 · 3분째 · CI" });
  });

  it("reads a teammate's open question as waiting on its owner", () => {
    expect(statusView(bot({ remote: "team", asking: true }), NOW, ko)).toEqual({
      tone: "blocked",
      text: "주인 답 기다리는 중",
    });
  });
});

describe("briefStatus", () => {
  it("gives idle a word", () => {
    expect(briefStatus(bot(), ko)).toEqual({ tone: "idle", text: "대기" });
  });

  it("keeps a watch to one word", () => {
    const watching = bot({ watch: [{ what: "CI", since: NOW }] });
    expect(briefStatus(watching, ko)).toEqual({ tone: "watching", text: "감시 중" });
  });

  it("matches the header for the rest", () => {
    for (const status of ["working", "blocked", "exited"] as const) {
      expect(briefStatus(bot({ status }), ko)).toEqual(statusView(bot({ status }), NOW, ko));
    }
  });
});
