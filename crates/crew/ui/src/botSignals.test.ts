import { describe, expect, it } from "vitest";
import {
  type BotSignal,
  LONG_RUN_MS,
  afterglowAt,
  afterglowOf,
  onBotSignals,
  peekBotSignal,
  publishBotSignals,
  publishBotUnread,
} from "./botSignals";
import type { AgentInfo } from "./types";

let n = 0;
const nextId = () => `bot-${++n}`;
const agent = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name: id,
  status: "idle",
  cmd: ["claude"],
  cwd: "/tmp",
  routines: [],
  ...over,
});

describe("publishBotSignals", () => {
  it("measures a run from the first look at it working to the look it ended", () => {
    const id = nextId();
    publishBotSignals([agent(id, { status: "working" })], 1_000);
    publishBotSignals([agent(id, { status: "working" })], 20_000);
    publishBotSignals([agent(id)], 41_000);
    expect(peekBotSignal(id).runMs).toBe(40_000);
  });

  it("stamps when a run ended, and clears the stamp when the next one starts", () => {
    const id = nextId();
    publishBotSignals([agent(id, { status: "working" })], 1_000);
    expect(peekBotSignal(id).endedAt).toBe(0);
    publishBotSignals([agent(id)], 4_000);
    expect(peekBotSignal(id).endedAt).toBe(4_000);
    publishBotSignals([agent(id)], 9_000);
    expect(peekBotSignal(id).endedAt).toBe(4_000);
    publishBotSignals([agent(id, { status: "working" })], 10_000);
    expect(peekBotSignal(id).endedAt).toBe(0);
  });

  it("keeps the last run's length until the next one ends", () => {
    const id = nextId();
    publishBotSignals([agent(id, { status: "working" })], 0);
    publishBotSignals([agent(id)], 5_000);
    publishBotSignals([agent(id)], 90_000);
    expect(peekBotSignal(id).runMs).toBe(5_000);
    publishBotSignals([agent(id, { status: "working" })], 100_000);
    publishBotSignals([agent(id)], 160_000);
    expect(peekBotSignal(id).runMs).toBe(60_000);
  });

  it("leaves a bot that was never seen working at zero", () => {
    const id = nextId();
    publishBotSignals([agent(id)], 0);
    expect(peekBotSignal(id)).toEqual({
      failed: false,
      asking: false,
      runMs: 0,
      endedAt: 0,
      unread: false,
    });
  });

  it("carries a failure and an open question from the list", () => {
    const id = nextId();
    publishBotSignals([agent(id, { failed: true, asking: true })], 0);
    expect(peekBotSignal(id)).toMatchObject({ failed: true, asking: true });
    publishBotSignals([agent(id)], 1);
    expect(peekBotSignal(id)).toMatchObject({ failed: false, asking: false });
  });

  it("wakes the faces only when something changed", () => {
    const id = nextId();
    let calls = 0;
    const off = onBotSignals(() => calls++);
    publishBotSignals([agent(id, { asking: true })], 0);
    publishBotSignals([agent(id, { asking: true })], 10);
    publishBotSignals([agent(id, { asking: true })], 20);
    expect(calls).toBe(1);
    publishBotSignals([agent(id)], 30);
    expect(calls).toBe(2);
    off();
  });

  it("forgets a bot that left the list", () => {
    const id = nextId();
    publishBotSignals([agent(id, { failed: true })], 0);
    publishBotSignals([], 1);
    expect(peekBotSignal(id).failed).toBe(false);
  });
});

describe("publishBotUnread", () => {
  it("marks the bots whose chat holds unseen lines, and clears them once seen", () => {
    const a = nextId();
    const b = nextId();
    publishBotSignals([agent(a), agent(b)], 0);
    publishBotUnread([a]);
    expect(peekBotSignal(a).unread).toBe(true);
    expect(peekBotSignal(b).unread).toBe(false);
    publishBotUnread([]);
    expect(peekBotSignal(a).unread).toBe(false);
  });

  it("survives the list being read again", () => {
    const id = nextId();
    publishBotSignals([agent(id, { status: "working" })], 0);
    publishBotUnread([id]);
    publishBotSignals([agent(id)], 5_000);
    expect(peekBotSignal(id)).toMatchObject({ unread: true, runMs: 5_000 });
    publishBotUnread([]);
  });

  it("wakes the faces only when it moved", () => {
    const id = nextId();
    publishBotSignals([agent(id)], 0);
    let calls = 0;
    const off = onBotSignals(() => calls++);
    publishBotUnread([id]);
    publishBotUnread([id]);
    expect(calls).toBe(1);
    publishBotUnread([]);
    expect(calls).toBe(2);
    off();
  });
});

describe("afterglowOf", () => {
  it("smiles after a quick run", () => {
    expect(afterglowOf({ failed: false, asking: false, runMs: 4000, endedAt: 0, unread: false }).kind).toBe("happy");
    expect(afterglowOf(undefined).kind).toBe("happy");
  });

  it("dances after a long one", () => {
    expect(afterglowOf({ failed: false, asking: false, runMs: LONG_RUN_MS, endedAt: 0, unread: false }).kind).toBe("success");
    expect(afterglowOf({ failed: false, asking: false, runMs: LONG_RUN_MS - 1, endedAt: 0, unread: false }).kind).toBe("happy");
  });

  it("droops after a failure, however long it ran, and holds it longest", () => {
    const failed = afterglowOf({ failed: true, asking: false, runMs: 90_000, endedAt: 0, unread: false });
    expect(failed.kind).toBe("failure");
    const long = afterglowOf({ failed: false, asking: false, runMs: 90_000, endedAt: 0, unread: false });
    expect(failed.ms).toBeGreaterThan(long.ms);
  });
});

describe("afterglowAt", () => {
  const sig = (over: Partial<BotSignal> = {}): BotSignal => ({
    failed: false,
    asking: false,
    runMs: 0,
    endedAt: 1_000,
    unread: false,
    ...over,
  });

  it("plays the usual moment from when the run ended, then ends", () => {
    expect(afterglowAt("idle", sig(), 1_500)).toEqual({ kind: "happy", left: 1_100, shown: true });
    expect(afterglowAt("idle", sig(), 2_600)).toMatchObject({ left: 0, shown: false });
  });

  it("keeps going while the chat is unread, however late", () => {
    const fail = sig({ failed: true, unread: true });
    expect(afterglowAt("idle", fail, 1_000 + 3_600_000)).toMatchObject({ kind: "failure", shown: true });
  });

  it("ends the moment the reader looks once the moment has passed", () => {
    const unseen = sig({ failed: true, unread: true });
    const seen = sig({ failed: true, unread: false });
    const later = 1_000 + 60_000;
    expect(afterglowAt("idle", unseen, later)?.shown).toBe(true);
    expect(afterglowAt("idle", seen, later)?.shown).toBe(false);
  });

  it("shows a reaction to a late-mounted face the same as to the first", () => {
    const s = sig({ runMs: 90_000, unread: true });
    expect(afterglowAt("idle", s, 50_000)).toMatchObject({ kind: "success", shown: true });
  });

  it("shows nothing before a run has ended, or while the bot is busy", () => {
    expect(afterglowAt("idle", sig({ endedAt: 0, unread: true }), 5)).toBeNull();
    expect(afterglowAt("working", sig({ unread: true }), 5)).toBeNull();
    expect(afterglowAt("idle", undefined, 5)).toBeNull();
  });
});
