import { describe, expect, it } from "vitest";
import { translate } from "./i18n";
import { askingAmong, briefStatus, collapsedGroupMark, statusView, waitingFailed, waitingOn, waitingUserPhrase } from "./statusView";
import type { AgentInfo, Group } from "./types";

const ko = (
  key: Parameters<typeof translate>[1],
  vars?: Record<string, string | number>,
) => translate("ko", key, vars);

function bot(over: Partial<AgentInfo> = {}): AgentInfo {
  return { id: "b", name: "b", status: "idle", cmd: [], cwd: "", routines: [], ...over };
}

const NOW = 1_000_000_000;

function group(over: Partial<Group> = {}): Group {
  return {
    id: "g",
    name: "g",
    collapsed: true,
    items: ["agent:a", "agent:b"],
    ...over,
  };
}

describe("collapsedGroupMark", () => {
  const working = bot({ id: "a", status: "working" });
  const blocked = bot({ id: "b", status: "blocked" });

  it("draws nothing when a lead is still shown", () => {
    expect(collapsedGroupMark(group({ lead: "a" }), [working, blocked])).toBeNull();
  });

  it("lets a question or an approval win over working", () => {
    expect(collapsedGroupMark(group(), [working, blocked])).toEqual({
      tone: "blocked",
      working: 1,
      attention: 1,
    });
    const asking = bot({ id: "b", status: "working", asking: true });
    expect(collapsedGroupMark(group(), [working, asking])).toEqual({
      tone: "blocked",
      working: 1,
      attention: 1,
    });
  });

  it("draws nothing when nobody is working or waiting", () => {
    expect(
      collapsedGroupMark(group(), [bot({ id: "a" }), bot({ id: "b", status: "exited" })]),
    ).toBeNull();
    expect(collapsedGroupMark(group({ collapsed: false }), [working, blocked])).toBeNull();
  });

  it("is a working dot when that is all there is", () => {
    expect(collapsedGroupMark(group(), [working, bot({ id: "b" })])).toEqual({
      tone: "working",
      working: 1,
      attention: 0,
    });
  });
});

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

describe("waiting on other bots", () => {
  const asked = { waiting_on: ["designer", "acme/acc_1"] };

  it("shows only while the bot rests, in the order it asked", () => {
    expect(waitingOn(bot(asked))).toEqual(["designer", "acme/acc_1"]);
    expect(statusView(bot(asked), NOW, ko)).toEqual({ tone: "waiting", text: "기다리는 중" });
    expect(briefStatus(bot(asked), ko)).toEqual({ tone: "waiting", text: "기다리는 중" });
  });

  it("gives way to needs review and working, and says nothing once exited", () => {
    expect(statusView(bot({ ...asked, status: "blocked" }), NOW, ko)?.tone).toBe("blocked");
    expect(statusView(bot({ ...asked, status: "working" }), NOW, ko)?.tone).toBe("working");
    expect(statusView(bot({ ...asked, status: "exited" }), NOW, ko)?.tone).toBe("exited");
    for (const status of ["blocked", "working", "exited"] as const) {
      expect(waitingOn(bot({ ...asked, status }))).toEqual([]);
    }
  });

  it("marks the bots whose turn failed, only among those waited on", () => {
    const failed = { waiting_on: ["designer", "dev"], waiting_failed: ["dev", "gone"] };
    expect(waitingFailed(bot(failed))).toEqual(["dev"]);
    expect(waitingFailed(bot({ ...failed, status: "working" }))).toEqual([]);
    expect(waitingFailed(bot(asked))).toEqual([]);
    expect(waitingFailed(null)).toEqual([]);
  });

  it("is plain idle with nobody to wait on", () => {
    expect(waitingOn(bot())).toEqual([]);
    expect(waitingOn(bot({ waiting_on: [] }))).toEqual([]);
    expect(waitingOn(null)).toEqual([]);
    expect(briefStatus(bot({ waiting_on: [] }), ko).tone).toBe("idle");
  });
});

describe("a waited-on bot asking the user", () => {
  const designer = bot({ id: "designer", name: "설계자", asking: true });
  const worker = bot({ id: "worker", name: "개발자" });
  const remote = bot({ id: "acme/acc_1", name: "원격", remote: "acme", asking: true });

  it("names the local bot that has a card open", () => {
    const ids = ["designer", "worker"];
    expect(askingAmong(ids, [designer, worker]).map((a) => a.id)).toEqual(["designer"]);
    expect(waitingUserPhrase(askingAmong(ids, [designer, worker]), ko)).toBe(
      "설계자가 사용자 답을 기다리는 중",
    );
  });

  it("counts the rest, and skips a remote card", () => {
    const second = bot({ id: "qa", name: "QA", asking: true });
    const ids = ["designer", "qa", "acme/acc_1"];
    expect(askingAmong(ids, [designer, second, remote]).map((a) => a.id)).toEqual([
      "designer",
      "qa",
    ]);
    expect(waitingUserPhrase(askingAmong(ids, [designer, second, remote]), ko)).toBe(
      "설계자 외 1명이 사용자 답을 기다리는 중",
    );
    expect(waitingUserPhrase(askingAmong(["acme/acc_1"], [remote]), ko)).toBeNull();
  });

  it("leaves the short status when nobody is asking", () => {
    expect(waitingUserPhrase([], ko)).toBeNull();
    expect(statusView(bot({ waiting_on: ["designer"] }), NOW, ko)?.text).toBe("기다리는 중");
  });
});
