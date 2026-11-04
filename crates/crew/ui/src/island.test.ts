import { describe, expect, it } from "vitest";
import { LONG_RUN_MS } from "./botSignals";
import {
  botNotices,
  koSubject,
  lifeAfterHover,
  noticeLife,
  noticeStays,
  topNotice,
  type BotSnap,
} from "./island";
import type { AgentInfo } from "./types";

function bot(id: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return { id, name: id, status: "idle", ...extra } as AgentInfo;
}

function step(prev: Map<string, BotSnap>, agents: AgentInfo[], now: number) {
  return botNotices(prev, agents, now);
}

describe("botNotices", () => {
  it("says nothing about a bot it sees for the first time", () => {
    const { notices } = step(new Map(), [bot("a", { status: "blocked", asking: true })], 0);
    expect(notices).toEqual([]);
  });

  it("speaks up when a bot asks or waits on an approval", () => {
    const first = step(new Map(), [bot("a", { status: "working" }), bot("b", { status: "working" })], 0);
    const { notices } = step(
      first.snaps,
      [bot("a", { status: "working", asking: true }), bot("b", { status: "blocked" })],
      1000,
    );
    expect(notices).toEqual([
      { botId: "a", kind: "question" },
      { botId: "b", kind: "blocked" },
    ]);
  });

  it("does not repeat a question that is still open", () => {
    const first = step(new Map(), [bot("a")], 0);
    const asked = step(first.snaps, [bot("a", { asking: true })], 1);
    expect(asked.notices).toHaveLength(1);
    expect(step(asked.snaps, [bot("a", { asking: true })], 2).notices).toEqual([]);
  });

  it("marks a failed run and a long one, and lets a quick one pass", () => {
    const start = step(new Map(), [bot("a"), bot("b"), bot("c")], 0);
    const working = step(
      start.snaps,
      [bot("a", { status: "working" }), bot("b", { status: "working" }), bot("c", { status: "working" })],
      1000,
    );
    const quick = step(
      working.snaps,
      [bot("a", { status: "idle", failed: true }), bot("b"), bot("c", { status: "working" })],
      2000,
    );
    expect(quick.notices).toEqual([{ botId: "a", kind: "failure" }]);
    const long = step(quick.snaps, [bot("a"), bot("b"), bot("c")], 1000 + LONG_RUN_MS);
    expect(long.notices).toEqual([{ botId: "c", kind: "success" }]);
  });

  it("keeps the start of a run across lists", () => {
    const a = step(new Map(), [bot("a")], 0);
    const b = step(a.snaps, [bot("a", { status: "working" })], 10);
    const c = step(b.snaps, [bot("a", { status: "working" })], 20);
    expect(c.snaps.get("a")?.startedAt).toBe(10);
  });

  it("asks before it reports how a run ended", () => {
    const a = step(new Map(), [bot("a", { status: "working" })], 0);
    const b = step(a.snaps, [bot("a", { asking: true, failed: true })], 1);
    expect(b.notices).toEqual([{ botId: "a", kind: "question" }]);
  });
});

describe("topNotice", () => {
  it("picks what waits on the user first", () => {
    expect(
      topNotice([
        { botId: "a", kind: "success" as const },
        { botId: "b", kind: "blocked" as const },
        { botId: "c", kind: "failure" as const },
      ]),
    ).toEqual({ botId: "b", kind: "blocked" });
    expect(topNotice([])).toBeNull();
  });
});

describe("notice timing", () => {
  it("keeps what needs the user and lets the rest go", () => {
    expect(noticeStays("question")).toBe(true);
    expect(noticeStays("error")).toBe(true);
    expect(noticeStays("success")).toBe(false);
    expect(noticeStays("ok")).toBe(false);
  });

  it("stays long enough to read, within 2 to 7 seconds", () => {
    expect(noticeLife("저장됨")).toBe(2000);
    expect(noticeLife("가".repeat(40))).toBe(3600);
    expect(noticeLife("가".repeat(200))).toBe(7000);
  });

  it("goes on where it stopped once the pointer leaves, with a beat to spare", () => {
    expect(lifeAfterHover(3000)).toBe(3000);
    expect(lifeAfterHover(200)).toBe(1200);
    expect(lifeAfterHover(0)).toBe(1200);
  });
});

describe("koSubject", () => {
  it("adds 가 after a vowel and 이 after a final consonant", () => {
    expect(koSubject("탈리")).toBe("탈리가");
    expect(koSubject("민준")).toBe("민준이");
    expect(koSubject("Crew 개발자")).toBe("Crew 개발자가");
    expect(koSubject("grok")).toBe("grok이(가)");
  });
});
