import { describe, expect, it } from "vitest";
import { fuzzyScore, imeKey, pushRecent, rowScore, stepIndex, switchRows } from "./quickSwitch";
import type { AgentInfo, Group } from "./types";

const bot = (id: string, name: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  name,
  status: "idle",
  cmd: ["claude"],
  cwd: "~",
  routines: [],
  ...extra,
});

const agents = [
  bot("crew-mw1", "디버거"),
  bot("bot-design", "디자이너", { status: "working" }),
  bot("bot-plan", "설계자"),
  bot("bot-infra", "서버"),
  bot("acme/acc_1", "민지", { remote: "acme" }),
];
const groups: Group[] = [
  { id: "g-crew", name: "Crew", collapsed: false, items: ["agent:crew-mw1", "agent:bot-plan"] },
  { id: "g-ops", name: "Ops", collapsed: true, items: ["agent:bot-infra"] },
];
const order = ["crew-mw1", "bot-plan", "bot-design"];

const ids = (opts: Partial<Parameters<typeof switchRows>[0]> = {}) =>
  switchRows({ agents, groups, order, recent: [], current: null, query: "", ...opts }).map(
    (r) => r.agent.id,
  );

describe("fuzzyScore", () => {
  it("ranks the whole text over its start, a word, the middle, and letters apart", () => {
    const whole = fuzzyScore("디버거", "디버거")!;
    const start = fuzzyScore("디버거", "디버")!;
    const word = fuzzyScore("crew 디버거", "디버")!;
    const inside = fuzzyScore("크루디버거", "디버")!;
    const apart = fuzzyScore("디자이너", "디너")!;
    expect(whole).toBeGreaterThan(start);
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(apart);
    expect(apart).toBeGreaterThan(0);
  });

  it("does not match letters out of order or missing", () => {
    expect(fuzzyScore("디버거", "거디")).toBeNull();
    expect(fuzzyScore("designer", "dx")).toBeNull();
  });

  it("ignores case", () => {
    expect(fuzzyScore("Crew", "crew")).toBe(1000);
  });
});

describe("rowScore", () => {
  it("finds a bot by its name, its id, or its group", () => {
    const row = { agent: agents[0], group: "Crew" };
    expect(rowScore(row, "디버")).not.toBeNull();
    expect(rowScore(row, "mw1")).not.toBeNull();
    expect(rowScore(row, "crew")).not.toBeNull();
    expect(rowScore(row, "서버")).toBeNull();
  });

  it("needs every word to match a field", () => {
    const row = { agent: agents[0], group: "Crew" };
    expect(rowScore(row, "crew 디버")).not.toBeNull();
    expect(rowScore(row, "ops 디버")).toBeNull();
  });
});

describe("switchRows", () => {
  it("typed nothing: recent first, then sidebar order, then bots folded away, open chat last", () => {
    expect(ids({ recent: ["bot-design", "gone"], current: "crew-mw1" })).toEqual([
      "bot-design",
      "bot-plan",
      "bot-infra",
      "acme/acc_1",
      "crew-mw1",
    ]);
  });

  it("names each bot's folder, or the router a teammate's bot is on", () => {
    const rows = switchRows({ agents, groups, order, recent: [], current: null, query: "" });
    const group = Object.fromEntries(rows.map((r) => [r.agent.id, r.group]));
    expect(group["crew-mw1"]).toBe("Crew");
    expect(group["bot-design"]).toBe("");
    expect(group["acme/acc_1"]).toBe("acme");
  });

  it("typed something: matches best first", () => {
    expect(ids({ query: "디" })).toEqual(["crew-mw1", "bot-design"]);
    expect(ids({ query: "디자" })).toEqual(["bot-design"]);
    expect(ids({ query: "ops" })).toEqual(["bot-infra"]);
    expect(ids({ query: "acme" })).toEqual(["acme/acc_1"]);
    expect(ids({ query: "없는봇" })).toEqual([]);
  });

  it("breaks ties in the empty list's order, and keeps the open chat findable", () => {
    expect(ids({ query: "디", recent: ["bot-design"] })).toEqual(["bot-design", "crew-mw1"]);
    expect(ids({ query: "디버", current: "crew-mw1" })).toEqual(["crew-mw1"]);
  });
});

describe("pushRecent", () => {
  it("puts the chat in front once and keeps the list short", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });
});

describe("stepIndex", () => {
  it("wraps at either end", () => {
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBe(0);
  });
});

describe("imeKey", () => {
  it("leaves the key that ends a Hangul syllable to the IME", () => {
    expect(imeKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(imeKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(imeKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
