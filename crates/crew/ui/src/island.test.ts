import { describe, expect, it } from "vitest";
import { LONG_RUN_MS } from "./botSignals";
import {
  botNotices,
  koSubject,
  lifeAfterHover,
  noticeLife,
  noticeStays,
  byRank,
  pushNotice,
  type IslandNotice,
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

describe("byRank", () => {
  it("puts what waits on the user last, so it lands on top", () => {
    expect(
      byRank([
        { botId: "a", kind: "blocked" as const },
        { botId: "b", kind: "success" as const },
        { botId: "c", kind: "failure" as const },
      ]).map((n) => n.botId),
    ).toEqual(["b", "c", "a"]);
  });
});

describe("pushNotice", () => {
  const plain = (seq: number, text: string): IslandNotice => ({ seq, stays: false, kind: "ok", text });
  const about = (seq: number, botId: string): IslandNotice => ({
    seq,
    stays: false,
    kind: "success",
    botId,
  });
  const seqs = (ns: IslandNotice[]) => ns.map((n) => n.seq);

  it("stacks the newest on top", () => {
    const { stack, dropped } = pushNotice([plain(1, "a")], about(2, "x"));
    expect(seqs(stack)).toEqual([2, 1]);
    expect(dropped).toEqual([]);
  });

  it("lets a newer word about the same bot, or the same words, take the old one's place", () => {
    const start = [about(2, "x"), plain(1, "a")];
    let r = pushNotice(start, about(3, "x"));
    expect(seqs(r.stack)).toEqual([3, 1]);
    expect(seqs(r.dropped)).toEqual([2]);
    r = pushNotice(start, plain(4, "a"));
    expect(seqs(r.stack)).toEqual([4, 2]);
    expect(seqs(r.dropped)).toEqual([1]);
  });

  it("pushes the oldest out past the limit", () => {
    const { stack, dropped } = pushNotice([plain(2, "b"), plain(1, "a")], plain(3, "c"), 2);
    expect(seqs(stack)).toEqual([3, 2]);
    expect(seqs(dropped)).toEqual([1]);
  });
});

describe("notice timing", () => {
  it("keeps what needs the user and lets the rest go", () => {
    expect(noticeStays("question")).toBe(true);
    expect(noticeStays("error")).toBe(true);
    expect(noticeStays("success")).toBe(false);
    expect(noticeStays("ok")).toBe(false);
  });

  it("gives a brief confirmation 3 seconds and the rest 7", () => {
    expect(noticeLife("ok", "auto", true)).toBe(3000);
    expect(noticeLife("ok", "auto")).toBe(7000);
    expect(noticeLife("warn", "auto")).toBe(7000);
    expect(noticeLife("success", "auto")).toBe(7000);
  });

  it("keeps what waits on the user, and everything but a brief word when Settings say so", () => {
    expect(noticeLife("question", "auto")).toBeNull();
    expect(noticeLife("error", "auto")).toBeNull();
    expect(noticeLife("success", "keep")).toBeNull();
    expect(noticeLife("ok", "keep")).toBeNull();
    expect(noticeLife("ok", "keep", true)).toBe(3000);
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
