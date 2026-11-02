import { describe, expect, it } from "vitest";
import {
  LONG_RUN_MS,
  afterglowOf,
  onBotSignals,
  peekBotSignal,
  publishBotSignals,
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
    expect(peekBotSignal(id)).toEqual({ failed: false, asking: false, runMs: 0 });
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

describe("afterglowOf", () => {
  it("smiles after a quick run", () => {
    expect(afterglowOf({ failed: false, asking: false, runMs: 4000 }).kind).toBe("happy");
    expect(afterglowOf(undefined).kind).toBe("happy");
  });

  it("dances after a long one", () => {
    expect(afterglowOf({ failed: false, asking: false, runMs: LONG_RUN_MS }).kind).toBe("success");
    expect(afterglowOf({ failed: false, asking: false, runMs: LONG_RUN_MS - 1 }).kind).toBe("happy");
  });

  it("droops after a failure, however long it ran, and holds it longest", () => {
    const failed = afterglowOf({ failed: true, asking: false, runMs: 90_000 });
    expect(failed.kind).toBe("failure");
    const long = afterglowOf({ failed: false, asking: false, runMs: 90_000 });
    expect(failed.ms).toBeGreaterThan(long.ms);
  });
});
