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
      held: false,
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
  /** A run that ends in idle at `at`, while the chat is unread or not. */
  function runEnds(id: string, at: number, unread: boolean) {
    publishBotSignals([agent(id, { status: "working" })], at - 5_000);
    if (unread) publishBotUnread([id], at);
    publishBotSignals([agent(id)], at);
  }

  it("holds the reaction of a run that ended with its chat unseen", () => {
    const id = nextId();
    runEnds(id, 10_000, true);
    expect(peekBotSignal(id)).toMatchObject({ endedAt: 10_000, held: true });
  });

  it("does not hold a run that ended with the reader in the chat", () => {
    const id = nextId();
    runEnds(id, 10_000, false);
    expect(peekBotSignal(id)).toMatchObject({ endedAt: 10_000, held: false });
  });

  it("lets go when the reader looks", () => {
    const id = nextId();
    runEnds(id, 10_000, true);
    publishBotUnread([], 20_000);
    expect(peekBotSignal(id).held).toBe(false);
  });

  it("holds when the unread arrives just after the list shows the run ended", () => {
    const id = nextId();
    runEnds(id, 10_000, false);
    publishBotUnread([id], 10_050);
    expect(peekBotSignal(id).held).toBe(true);
  });

  it("does not revive a reaction the reader has seen when a later line arrives", () => {
    const id = nextId();
    runEnds(id, 10_000, true);
    publishBotUnread([], 20_000);
    publishBotUnread([id], 3_600_000);
    expect(peekBotSignal(id).held).toBe(false);
  });

  it("holds nothing for a run that ended blocked or asleep, nor a later idle", () => {
    const id = nextId();
    publishBotSignals([agent(id, { status: "working" })], 0);
    publishBotUnread([id], 4_000);
    publishBotSignals([agent(id, { status: "blocked" })], 5_000);
    expect(peekBotSignal(id)).toMatchObject({ endedAt: 0, held: false });
    publishBotSignals([agent(id)], 900_000);
    expect(peekBotSignal(id)).toMatchObject({ endedAt: 0, held: false });
  });

  it("does not replay a reaction when the bot leaves idle and comes back", () => {
    const id = nextId();
    runEnds(id, 10_000, true);
    publishBotSignals([agent(id, { status: "exited" })], 20_000);
    publishBotSignals([agent(id)], 30_000);
    expect(peekBotSignal(id)).toMatchObject({ endedAt: 0, held: false });
    publishBotUnread([], 31_000);
  });

  it("clears the hold when the bot starts again", () => {
    const id = nextId();
    runEnds(id, 10_000, true);
    publishBotSignals([agent(id, { status: "working" })], 11_000);
    expect(peekBotSignal(id)).toMatchObject({ endedAt: 0, held: false });
  });

  it("remembers an unread chat for a bot the list names later", () => {
    const id = nextId();
    publishBotUnread([id], 0);
    runEnds(id, 10_000, false);
    expect(peekBotSignal(id).held).toBe(true);
    publishBotUnread([], 11_000);
  });

  it("makes no entry for a bot the list has not named", () => {
    const id = nextId();
    publishBotUnread([id], 0);
    expect(peekBotSignal(id)).toEqual({
      failed: false,
      asking: false,
      runMs: 0,
      endedAt: 0,
      held: false,
    });
    publishBotUnread([], 1);
  });

  it("wakes the faces only when it moved", () => {
    const id = nextId();
    runEnds(id, 10_000, false);
    let calls = 0;
    const off = onBotSignals(() => calls++);
    publishBotUnread([id], 10_100);
    publishBotUnread([id], 10_200);
    expect(calls).toBe(1);
    publishBotUnread([], 10_300);
    expect(calls).toBe(2);
    off();
  });
});

describe("afterglowOf", () => {
  it("smiles after a quick run", () => {
    expect(afterglowOf({ failed: false, asking: false, runMs: 4000, endedAt: 0, held: false }).kind).toBe("happy");
    expect(afterglowOf(undefined).kind).toBe("happy");
  });

  it("dances after a long one", () => {
    expect(afterglowOf({ failed: false, asking: false, runMs: LONG_RUN_MS, endedAt: 0, held: false }).kind).toBe("success");
    expect(afterglowOf({ failed: false, asking: false, runMs: LONG_RUN_MS - 1, endedAt: 0, held: false }).kind).toBe("happy");
  });

  it("droops after a failure, however long it ran, and holds it longest", () => {
    const failed = afterglowOf({ failed: true, asking: false, runMs: 90_000, endedAt: 0, held: false });
    expect(failed.kind).toBe("failure");
    const long = afterglowOf({ failed: false, asking: false, runMs: 90_000, endedAt: 0, held: false });
    expect(failed.ms).toBeGreaterThan(long.ms);
  });
});

describe("afterglowAt", () => {
  const sig = (over: Partial<BotSignal> = {}): BotSignal => ({
    failed: false,
    asking: false,
    runMs: 0,
    endedAt: 1_000,
    held: false,
    ...over,
  });

  it("plays the usual moment from when the run ended, then ends", () => {
    expect(afterglowAt("idle", sig(), 1_500)).toEqual({ kind: "happy", left: 1_100, shown: true });
    expect(afterglowAt("idle", sig(), 2_600)).toMatchObject({ left: 0, shown: false });
  });

  it("keeps going while held, however late", () => {
    const fail = sig({ failed: true, held: true });
    expect(afterglowAt("idle", fail, 1_000 + 3_600_000)).toMatchObject({ kind: "failure", shown: true });
  });

  it("ends once the hold is let go and the moment has passed", () => {
    const unseen = sig({ failed: true, held: true });
    const seen = sig({ failed: true, held: false });
    const later = 1_000 + 60_000;
    expect(afterglowAt("idle", unseen, later)?.shown).toBe(true);
    expect(afterglowAt("idle", seen, later)?.shown).toBe(false);
  });

  it("shows a reaction to a late-mounted face the same as to the first", () => {
    const s = sig({ runMs: 90_000, held: true });
    expect(afterglowAt("idle", s, 50_000)).toMatchObject({ kind: "success", shown: true });
  });

  it("shows nothing before a run has ended, or while the bot is busy", () => {
    expect(afterglowAt("idle", sig({ endedAt: 0, held: true }), 5)).toBeNull();
    expect(afterglowAt("working", sig({ held: true }), 5)).toBeNull();
    expect(afterglowAt("idle", undefined, 5)).toBeNull();
  });
});
